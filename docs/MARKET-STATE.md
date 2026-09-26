# Market state — breakout, rejection, breakdown, range

Built 23 Sep 2026, to the owner's specification. The question a chart is opened
to answer, answered by the desk: **is price going through the level, or has it
been turned back?**

Everything here is on the Live screen, under the price chart.

---

## The one distinction the whole thing rests on

| | What it is | How it is shown |
|---|---|---|
| **Score** | The weighted confirmations, out of 100 | The badge says "score", never "%" |
| **Probability** | How often this state actually preceded the move | **Not built yet.** Nothing on screen claims to be one |

A number that looks like a probability and is not is worse than no number. The
confidence on the card is a weighted sum of things that are true right now; it
is not calibrated against history, and until it is, nothing says it is. See
**What is not built** at the end.

The second distinction, in the same spirit: **a setup is not a fact.** The card
says "Breakout likely" while price is near a level and "Breakout confirmed"
only after a bar closed through it with the volume and the body to back it.
Unconfirmed states never get the confirmed colour.

---

## The states

```
RANGE → BREAKOUT_WATCH → BREAKOUT_CANDIDATE → BREAKOUT_CONFIRMED → RETEST_HOLD
                                     ↓
                            FALSE_BREAKOUT / REJECTION
```

and the mirror below: `BREAKDOWN_WATCH → BREAKDOWN_CANDIDATE →
BREAKDOWN_CONFIRMED`, with `FALSE_BREAKDOWN` and `SUPPORT_REJECTION`.

**The order the branches are checked is the design.** A bar that closes back
under a level it closed above last bar satisfies "close below resistance"
exactly as a quiet mid-range bar does, so the failure branches are asked first;
a bar whose high is through and whose close is not is a rejection, so that is
asked before the range branch, which would otherwise swallow it.

---

## The formulas

All in `app/server/src/domain/market-state.ts`, all pure, all tested.

**Tolerance** — how far past a level still counts as the level:

```
tolerance = max(0.10 × ATR, 5 ticks)
```

One number, used at every comparison. It is the single thing that decides how
many false breakouts this reports.

**Level** — the timeframe's own nearest swing high and low where `readMarket`
found them; otherwise the highest high and lowest low of the last 20 bars,
*excluding the bar being formed* (a level that includes the bar you are testing
against it can never be broken).

**Volume** — against the **median** of the last 20 bars, not the mean: one
violent bar drags a mean up enough that the next violent bar stops looking
unusual.

```
volumeRatio = volume / median(last 20)
  < 1.0  weak     1.0–1.5 normal     1.5–2.0 strong     > 2.0 burst
```

**Confirmation** — a break counts only with all four:

```
close > resistance + tolerance          (or < support − tolerance)
volumeRatio ≥ 1.5
bodyRatio   ≥ 0.55        bodyRatio = |close − open| / (high − low)
closeLocation ≥ 0.70      closeLocation = (close − low) / (high − low)
```

plus `|close − open| ≥ 0.3 × ATR` where an ATR is known.

**The score** — weights in `SCORE_WEIGHTS`, and they sum to 1 (a test says so,
because a weight added without taking one away silently rescales every score
the desk has ever shown):

| Part | Weight | What earns it |
|---|---|---|
| Level break | 0.25 | Confirmed or retest 1.0, candidate 0.6, watch 0.3 |
| Volume | 0.20 | Ratio against the 1.5× bar |
| Candle | 0.15 | Body share and where it closed |
| Retest | 0.15 | A second close the right side of the level |
| Flow | 0.10 | OI building (0.4), CVD agreeing (0.3), aggressors agreeing (0.3) |
| MTF | 0.10 | Share of timeframes pointing the same way |
| Regime | 0.05 | With the trend 1.0, quiet 0.6, range 0.4, against it 0 |

**A part that could not be measured scores zero** rather than being dropped and
the rest rescaled: a break with no flow behind it is less proven than one with
the flow agreeing, and hiding the gap would say the opposite. The card marks
those "not measured", which is not the same as failed.

**The plan** — off the ATR, so it reads sensibly on a quiet afternoon and on a
day BTC moves two thousand:

```
target1      = level ± 1 × ATR
target2      = level ± 2 × ATR
invalidation = level ∓ 1 × ATR
```

Both sides are always returned, because a level is the same number whichever
way price leaves it.

---

## Up or down, in one word

`domain/bias.ts` turns everything measured into the one thing a chart is
opened to answer. Every reading with a direction casts a vote, weighted by what
it is worth hearing from:

| Evidence | Weight | Why |
|---|---|---|
| The state, confirmed | 3 | The market having actually done something |
| The state, a setup | 1.5 | Half of a fact |
| Timeframes agreeing | 3 × share | Six of six outranks four of six, and both outrank one bar |
| Flow (CVD, aggressors) | 1 each | Who is crossing the spread |
| Market structure | 2 | The swings, which survive a bar |
| Regime | 1.5 | With the trend or against it |
| A candle shape | 1 × fade | One bar's opinion, fading 20% a bar behind |
| A reading | 1 | And **zero** where it could not be taken |

Under a 12-point lean it says **no lean** rather than picking a side to fill
the badge. The badge shows the weight each way -- "8 vs 3" -- and never a
percentage: what is true now is not how often it works out, and a lone figure
would be read as the second thing. That number needs the matched-state history;
see **What is not built**.

## Patterns and indicators

The **price-action panel is gone** (24 Sep): it sat in the left column saying
"Trend falling, RSI 38.8, MACD bearish, VWAP 85,648" -- the same readings the
summary under the chart was already showing, in different words, a screen away
from the chart they describe. Two panels that can disagree about RSI is one
panel too many. Trend, structure and the distance to each level are rows in the
readings now, at the top where they belong, and the strip under the chart is
one row of two columns: the shapes on the left, the readings on the right.

`domain/patterns.ts` names what the bars are doing, in three layers:

* **Candles** -- doji and its two, high wave, marubozu, hammer / hanging man,
  shooting star / inverted hammer, pin bars, engulfing, harami and harami
  cross, piercing, dark cloud, tweezers, matching high and low, counterattack,
  kicking, on-neck / in-neck, thrusting, morning and evening star, three
  soldiers and crows, three inside and outside up and down, abandoned baby,
  three gaps.
* **Shapes** -- higher lows, lower highs, the three triangles, rectangle, level
  tests with a touch count, volume buildup, compression.
* **Market structure** -- higher high / higher low / lower high / lower low,
  equal highs and lows, **BOS**, **CHOCH**, market structure shift, liquidity
  sweeps either side, double and triple tops and bottoms, head and shoulders
  and its inverse, channels up and down, bull and bear flags.

`domain/indicators.ts` holds the arithmetic -- returns, CLV, ROC, mean,
standard deviation, **z-score**, **percentile**, **efficiency ratio**, EMA,
MACD, **Bollinger %B and width**, **range position (Donchian)**,
**stochastic**, **Williams %R**, **CCI**, **OBV slope**, **choppiness**,
**Aroon**, **SuperTrend**, **vortex**, **TRIX**, **awesome oscillator**,
**MFI**, **Chaikin money flow**, **relative volume**, **HMA**, and the
price-action read itself (trend, structure, and the distance to each level) --
and assembles the readings. Everything here needs only the candles
the chart is already drawing, which is why these are the ones that got built:
no second feed, no second key, nothing more to be down at four in the morning.

**Neither is shown in full, on purpose.** A card with thirty patterns on it is
a card nobody reads. `relevant()` and `relevantIndicators()` pick four patterns
and six readings *for the state price is in*: while a level is being tested,
volume, the aggressor split and the bar's shape decide it, and the pattern that
**contradicts** the push outranks one more that agrees with it — because that
is what a rejection looks like as it forms. The rest stay in the API payload
for anything that wants to measure them.

---

## The journal, and whether any of this works

`market_states` (migrations `market-010` and `market-011`) records **every
state the desk calls, when it changes** — not per poll, or the table would be a
record of how often the page was open.

It holds the whole reading, not the verdict alone: the words and the sentence,
the volume ratio and the ATR, the score's parts, the inputs it was measured
from, and the patterns and readings that were on the card (JSONB, because their
shape is the engine's and a column per indicator would be a migration every
time one is added). The first version kept the levels and the outcome, which
lists the calls and cannot answer the only question worth asking of them —
*which of these readings ever paid* — since none of it can be reconstructed
from bars afterwards.

Grading also writes **where price actually finished** the window and the BTC
points from the call, so the history's "+350 pts" is a recorded figure rather
than one that depends on when the screen happened to be open.

Each row is graded **oldest ungraded first**, after a window sized to its own
timeframe (5m → 30 min, 15m → 90, 1h → 4 hours), by a rule fixed before the
outcome was known — and the rule asks the **trigger first**:

| Outcome | What it means |
|---|---|
| `NOT_TRIGGERED` | Price never reached the trigger. Nothing happened. |
| `TARGET_HIT` | Triggered, and target 1 came before the stop. |
| `INVALIDATED` | Triggered, and the invalidation came first — including a bar that reached both, since the order is not in the bar. |
| `EXPIRED` | Triggered, and the window closed with neither reached. |
| `NOT_GRADED` | A range. "Nothing is happening" is not a prediction. |

**The word "wrong" is gone from the live screen (24 Sep 2026), and it was
wrong.** A breakout watch says *over 84,532 this goes to 84,731*. If price
never reached 84,532 there was no trade to be right or wrong about — and the
old grader marked every untriggered setup WRONG, so the screen filled with red
for calls that were never anything but a plan. The trigger is now the first
question asked of the bars; a call still inside its window says **Waiting**,
one that never started says **Not triggered**, and the only red word is for a
call that ran and hit its own invalidation.

Rows written before the change carry `CORRECT` / `WRONG` / `UNRESOLVED`; they
are mapped on read rather than rewritten, so the history stays readable without
editing what was recorded.

The tally counts only the calls that **triggered and finished** — a setup whose
trigger was never reached is not counted either way, because marking the desk
down for a trade nobody could take is how a hit rate ends up describing the
grader.

The card shows the tally as "3 of 4 came good", never as a percentage. Four
calls is not a hit rate.

---

## On the chart, and under it

The Live screen shows the chart and everything read off it as **one panel**
(`MarketPanel`), in the order somebody reads it: the candles, the shapes on
them, the numbers behind those, the sentence, then the plan. It was four cards
in a column until 23 Sep -- four borders and four headings for one thought,
with the plan a scroll away from the level it is about.

1. **The chart is `lightweight-charts`.** The candles, the volume, the axes,
   the crosshair, the wheel, the pinch and the pan are the library's; they were
   a thousand lines of hand-written SVG until 23 Sep and they are a solved
   problem. It opens on about ninety bars with a gutter of twelve kept clear to
   the right, and *Fit* shows the whole series. Zoom and pan stay locked until
   asked for, because the chart sits in the middle of a scrolling page.

   **Nothing is drawn as a price line.** The walls went first -- they are where
   the board's open interest sits, not where BTC will settle, and they are
   named under the chart instead -- and then spot, whose axis tag sat on top of
   the series' own last-price tag a few dollars away, both over the callouts.
   The candles already show where price is. What is drawn is what the state is
   judged against: the two bands.

   The possible-range box went the same way. It quoted the two numbers the
   shaded bands either side of it were already labelled with: the same fact
   three times, in the most crowded corner of the screen. The card still gives
   the range in words, where there is room.

   Everything the library has no opinion about -- the bands, the swing lines,
   the callouts -- is laid out in `chart-overlay.ts` as pixels and drawn as one
   SVG over the canvas. The split is the point: the library owns pixels of
   price, the desk owns meaning, and the geometry stays testable because the
   canvas is not.
2. **Bands, not lines.** The resistance and support the state is judged against
   are shaded behind the candles, to the same tolerance the engine breaks them
   by, each labelled with its name and the two prices it runs between. A level
   is never one price, and a hairline invites an argument about a wick two
   dollars through it.
3. **The trendlines.** The two lines a chart reader draws by hand -- through
   the last two swing lows and the last two swing highs -- carried forward to
   the newest bar, which is the only place a trendline says anything. Found on
   the server (`trendLines` in `domain/patterns.ts`) with everything else that
   reads the bars, and given in bars back from the newest bar so a panned or
   zoomed window still puts them on the right candles.
4. **The projection.** An arrow out of the newest bar to each target, in a box
   saying which way, the price, and how far that is from here in percent --
   drawn in the gap kept clear to the right of the last candle so it never
   covers a bar. A target beyond the scale is drawn at the edge *with its
   number* rather than dropped; losing it entirely would read as there being no
   target. Between the two sits the **possible range**, because "neither has
   happened yet" is a reading too, and the one most often mistaken for a signal.
5. **The flags, and the one word.** What the desk called is flagged on the bar
   it was called on -- a confirmed break, a rejection, a retest that failed, a
   bounce -- and so is every pattern it named, on the bar it was named on.
   "Bearish Engulfing" in a list means very little until you can see which
   candle it was. The flags come from the journal and from the same pattern
   list the strip shows, never from a second pass over the bars: a chart that
   disagrees with the card under it is worse than a chart with nothing on it. A
   watch never gets one -- there are dozens an hour and none of them has
   happened -- one flag a bar, at most eight, newest kept. The header carries
   the regime in a word: **↗ Uptrend / ↘ Downtrend / ↔ Range / → Quiet**.
6. **The strip.** Pattern detection (four, with a small drawing of each shape)
   and the indicator summary (six, the reading inside a dial where it has
   natural bounds and standing alone where it does not -- MACD's histogram has
   no top, and a dial would be inventing one), then **the sentence**:

   > If 86,800 breaks and a 15m candle closes above it with volume, the next
   > move is towards 87,200 – 87,600. If it is rejected, watch 86,200 for the
   > short.

   Both branches, always, while neither has happened: a sentence that gives
   only the side currently favoured is the one that gets somebody caught on
   the other. It is built on the server (`insightFor`) so the sentence, the
   card and the journal cannot drift apart.
7. **The plans, always.** Breakout / range / breakdown with target 1, target 2
   and the stop on all of them, under every tab. They were folded away except
   on the Levels tab; a stop you have to change tab to read is one you set late.
8. **The signal history**, five calls a page, newest first. Each row names the
   level it was a call about (resistance over, support under), the target and
   what that was worth in index points, then what BTC actually did in points --
   from the graded row where there is one, otherwise to the next call, or to
   the price now for the newest. The colour follows the call rather than the
   direction, so a fall after a breakdown is green. The tally stays a count
   ("3 of 4 came good"), because four calls is not a hit rate.

The analysis sits **beside** the chart on a wide screen and drops under it
below 1100px. The panel runs the width of the desk: in the middle of three columns the chart
was about six hundred pixels, which is a candle every two pixels and a plan in
five-digit numbers three abreast.

## What the Live screen dropped (24 Sep)

Four panels went, and none of their readings did:

| Gone | Where its content is now |
|---|---|
| Price action | The six key readings on the analysis card, always on screen |
| Key levels | The bands on the chart, and the distance rows in the readings |
| Expiry direction | The **Expiry** tab on the analysis card |
| Option bias · CE / PE | The **Options** tab on the same card |
| Strike finder | The strategy decision, which already picked the strike |

The finder's helpers went with it -- `findStrikes`, `finderRanks`,
`DESK_FILTER`, `filtersChanged`, `candidates` -- and so did the branch in
`pick()` that could only fire when a finder filter had been moved. Code nothing
renders is code that rots, and a filter nothing can change is a branch that can
only ever mislead the next reader.

## What the card carries now

Beside the confirmations: **market regime**, **volatility** (from ATR as a
share of price) and **timeframe alignment** — the three things a reader asks
before any of the detail. Under them, the **key levels** either side, named the
way a trader names them: R1 and S1 are what price is working against now, R2
and S2 are where it goes if those give way, and a level the hourly chart also
knows is marked *strong*.

## One card, no tabs

The card runs down in the order somebody reads it: the banner, **what has to be
true**, **the trade either way**, **where the board says it settles**, and
**which side the options are being bought on**. Then the signal history.

It had six tabs for about an hour -- Analysis, Levels, Patterns, Indicators,
Expiry, Options -- and every one of them hid an answer to a question already
being asked on the same screen. The patterns and the readings are in the strip
beside the chart; the levels *are* the plans, which are never hidden; and the
expiry read and the CE/PE bias were two more cards in the right-hand column
asking *which way and how sure* from the options board instead of the bars. A
tab bar over a card this short is a filing cabinet for one page.

The six-reading strip went the same way: trend, structure, RSI, MACD, VWAP and
ATR are rows in the readings beside the chart, and saying them twice on one
screen is how two panels come to disagree about RSI.

The expiry panel's **"Why"** list went with it -- eight rows of dots and plus
signs, which is a weight table rather than a reading. What each part scored is
still in the payload for anything measuring the model.

**Their logic is untouched.** The panels are built where their inputs are, in
`Overview`, and handed to the card through the chart slot; the card renders
what it is given and has no idea what an expiry is. The move changed where they
are shown and nothing else.

The readings tab shows **twenty**, in the order the state cares about -- what
decides this state first, then the rest. Rows made that possible: the same
space held six tiles with dials on them.

## The big-move catch

The early-warning panel answers a different question from the state card --
*is something about to happen* rather than *which way* -- and it now shows its
working the same way. Every trigger carries **how far it has come towards its
own threshold, out of 100**, with a bar behind it; the lamp still says whether
the threshold is actually crossed, because those are different claims and only
the second is one a position is changed on. The header carries the weighted
mean of those scores beside the band: the pressure moves long before the band
does, which is the whole point of an early warning rather than a late one.

Nine grey lamps look identical at twenty and at eighty. Eighty is the
interesting one.

The reading is journalled server-side (`market/shock-history.ts`,
`shock_snapshots`) and settled fifteen minutes later against where price went,
so "when it said sudden, did anything happen?" has an answer that does not
depend on who was watching. See docs/DB-INVENTORY.md.

## Where each piece lives

| Piece | File |
|---|---|
| The rules, pure | `app/server/src/domain/market-state.ts` |
| Patterns | `app/server/src/domain/patterns.ts` |
| Indicator arithmetic | `app/server/src/domain/indicators.ts` |
| Fetching and assembling | `app/server/src/market/state-read.ts` |
| The journal and grading | `app/server/src/market/state-history.ts` |
| Routes | `GET /api/market-state?tf=`, `GET /api/market-state/history` |
| The card | `app/web/src/components/desk/MarketState.tsx` |
| The chart | `app/web/src/components/desk/PriceChart.tsx` (lightweight-charts) |
| The overlay geometry, pure | `app/web/src/components/desk/chart-overlay.ts` |
| The strip under the chart | `app/web/src/components/desk/ChartReadout.tsx` |
| The one panel they all sit in | `app/web/src/components/desk/MarketPanel.tsx` |

Tests: `test/domain/market-state.test.ts` (25), `test/domain/patterns.test.ts`
(19), `test/domain/indicators.test.ts` (12), `test/market/state-read.test.ts`
(6), `test/market/state-history.test.ts` (5), `MarketState.test.tsx` (13),
`ChartReadout.test.tsx` (7), `MarketPanel.test.tsx` (3), `chart-overlay.test.ts`
(12) for the bands, lines and callouts, and `PriceChart.test.tsx` (7) against a
stubbed library.

---

## What is not built

The owner's specification goes further than this, and the rest is honest to
name rather than to half-build:

1. **Calibrated probability.** P(UP) / P(DOWN) / P(RANGE) per timeframe from
   matched historical states (KNN or Mahalanobis over a feature vector), with
   the expected move as a distribution rather than an ATR multiple. This is the
   piece that would let the card say "78%" and mean it. It needs the 735 days
   of history joined to the state features, and a calibration pass (Platt or
   isotonic) measured by Brier score.
2. **Signal persistence** — requiring n of m bars to confirm before the state
   advances, rather than the single closed bar it uses now.
3. **The wider formula list** — Hurst, entropy, autocorrelation, correlation
   against other assets, Bayesian stacking. Research features; none of them
   belongs on a live card until something has measured that it pays.
4. **The options half** — turning a state into a CE / PE side and a strike.
   The desk already has the gates (`domain/direction.ts`, `precheck.ts`); what
   is missing is the link from a confirmed state to the side they are asked
   about.
