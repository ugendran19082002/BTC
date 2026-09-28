# The price chart

Built 28 Sep 2026. One 5-minute chart with every price-action / SMC concept the
engine finds drawn on the candles themselves, and a corner readout (the HUD)
that says what the engine knows now and what it is waiting for. Nothing is
explained beside the chart.

| File | What it is |
|---|---|
| `app/web/src/lib/smc/engine.ts` | The engine: one closed candle at a time, no lookahead. |
| `app/web/src/lib/smc/types.ts` | Its vocabulary. |
| `app/web/src/lib/smc/context.ts` | Closed-candle filter, timeframe folding, trend-as-known-at, the context row. |
| `app/web/src/lib/smc/readout.ts` | The HUD's words, the context gate, the chart's own record. |
| `app/web/src/components/desk/chart/scene.ts` | Engine state → boxes / lines / marks in bar-index and price. Clutter is decided here. |
| `app/web/src/components/desk/chart/smc-primitive.ts` | Draws the scene on the chart's canvas (a lightweight-charts series primitive). |
| `app/web/src/components/desk/chart/label-layout.ts` | Label placement by priority; nothing drawn over anything. |
| `app/web/src/components/desk/chart/ChartHud.tsx` | The corner readout. |
| `app/web/src/components/desk/PriceChart.tsx` | The chart: candles, volume, the engine, the primitive, the HUD, the toolbar. |
| `app/web/src/components/desk-screen/DeskChart.tsx` | Fetches the context candles (1H, 5m, 1m) and hands the chart its context. |

---

## The no-lookahead contract

The engine has one way in, `push(bar)`, and sees only the candles pushed
before. Every object records where it is drawn (`at`) and which candle's
*close* made it knowable (`known`); a swing with a two-candle confirmation is
`at: 40, known: 42`. Nothing is edited later: a zone touched, filled or broken,
a pool swept or taken, a setup moving through its states -- each is a new
event with its own `known`.

The chart gives the engine **closed candles only**. The forming candle is
drawn, but nothing is read off it, so no label appears and vanishes within a
candle.

`engine.test.ts` checks the contract directly: over 864 five-minute candles,
the history at every candle *k* is identical whether the engine stopped at *k*
or ran to the end. A second test checks that a setup's plan never changes
once it is made. If either fails, something is reading the future.

Higher timeframes follow the same rule: a 1H candle counts from its close, and
the trend a setup records is the one known at the setup's own candle close
(`trendTimeline`).

---

## The rules

Each is one function in `engine.ts`, and deliberately plain.

| Concept | Rule |
|---|---|
| Swing (HH / HL / LH / LL / EQH / EQL) | Fractal, two candles each side; labelled against the previous confirmed swing of that side; equal within 0.1 ATR. |
| BOS / CHoCH / MSS | A close through the latest unbroken swing. With the trend BOS, against it CHoCH; a CHoCH on a displacement candle is MSS. |
| Order block | On a break: the last opposite-coloured candle at the origin of the breaking leg (the extreme since the broken swing, up to four candles back). |
| FVG | Three candles: the first's high below the third's low (bullish), or the reverse; at least 0.05 ATR. |
| Zone events | `touched` (first retest), `filled` (a gap's far edge), `broken` (a close through): an OB is then a **breaker**, an FVG an **IFVG**. |
| Liquidity | Every confirmed swing is resting liquidity (BSL / SSL); two within tolerance merge into EQH / EQL. PDH / PDL / PWH / PWL / PMH / PML and the Asia and London highs and lows are levels, known from the candle after their period ends. |
| Sweep vs taken | A wick through that closes back is a **sweep** (with its session: "London SSL sweep"); a close through **takes** it. |
| Displacement | Body at least 1.5 ATR (of the previous candle) and 60% of the range. |
| Candle tags | Engulfing, pin bar, inside bar, doji, volume spike (2x the 20-candle mean), volume dry-up (0.35x). |
| Premium / discount | Between the latest confirmed swing high and low; EQ at 50%; OTE 62-79% back, in the trend's direction. |
| VWAP / day open | Per UTC day (00:00 UTC = 05:30 IST, the desk's entry). |
| Sessions | By UTC hour: Asia 00-07, London 07-12, New York 12-20. |

---

## The setup and the trade

```
liquidity swept (SSL for a long)              FORMING
  → CHoCH / BOS in the new direction
  → displacement: a displacement candle, or the FVG such a move leaves
  → an OB (else an FVG) left by the move      READY: plan fixed
  → entry                                     ACTIVE
  → TP1 / TP2 / TP3, or the stop
```

Continuation setups start at a with-trend BOS made with displacement, no sweep
needed. Short is the mirror.

**The plan, fixed at READY and never moved:**

- **Stop** -- beyond the POI's distal edge plus max(1 point, 0.15 ATR), and at
  least 1.5 ATR from the entry. Wider than 4 ATR is no trade.
- **Targets** -- TP1 the nearest internal liquidity (swing, EQH / EQL, Asia /
  London high or low), TP2 the next external level (PDH / PWH / PMH ...), TP3
  the opposing OB or the next level; each carries its reason. R multiples only
  where the chart has no level left.
- **Entry** -- at the close of the break itself (the desk's option; see the
  research below). The engine also supports entering at the close that
  confirms a retest, a resting limit, and a hybrid of the two.

**In the trade:** 30% off at TP1, 30% at TP2, 40% at TP3. The stop moves to
break-even only after TP1 *and* a new confirmed swing in the trade's favour;
after TP2 it trails behind each confirmed swing; it only ever tightens, and
each move is recorded in `trail`. Inside one candle the stop is checked before
the targets.

**Context gate.** A setup against the 30M bias or the 15M structure is shown
but called **NO TRADE**, faded, with what it runs against.

**Refused plans are marked** on the candle they ended -- "No long: ran, no
retest", "No short: stop too wide" -- so the chart says why a visible move
had no trade.

---

## What the research says (research/SMC-STUDY.txt)

`app/web/scripts/smc-study.ts` replays the engine over every cached 5m candle
(Jan 2024 - Aug 2026, 275,548 candles) with fees of 0.05% a side. Eighteen
variants were declared in three rounds, each round chosen on 2024-25 and
judged once on 2026. The findings:

1. **Before fees every variant is near zero** (-0.17R to +0.07R a trade).
   The rules describe the chart; they do not predict its direction on BTC.
2. **Fees decide the result.** On 5m a round trip costs about 0.3R. The same
   rules on 15m lose -0.17R a trade in 2026 and on 1H -0.01R (113 trades) --
   bigger moves make the same fee a smaller share of R. Neither is an edge.
3. **Retest vs momentum.** Waiting for the retest (J) caught 8% of 1-hour
   moves of 1%+ and lost -0.58R a trade in 2026; entering at the break (L)
   caught 36% and lost -0.46R. The hybrid (retest, or the break with a
   displacement candle and the 1H agreeing) landed between them.
4. A TP1 minimum of 1.5R removed more good trades than bad; the London / New
   York filter changed nothing; maker-fee take-profits help by about 0.03R.

The desk runs L on the 5m chart (`DESK_SMC_OPTIONS`), and the HUD prints its
measured record -- 5,245 trades, 46% winners, -0.35R a trade after fees, 2026
-0.46R -- beside every setup: information, not a signal. The search stopped at
eighteen variants: more on the same data would find luck, not an edge.

---

## What is drawn, and what is left out

Layers (the toolbar's Layers menu, remembered per browser): HTF (1H order
blocks, 15m breaks), structure, liquidity, OB / FVG, levels, premium /
discount, sessions, VWAP, candle tags, trade, saved levels. Sessions, VWAP and
candle tags start off.

Clutter rules in `scene.ts`: three resting pools a side (nearest), three OBs
and three FVGs a direction (nearest), the latest six sweeps, the latest twelve
breaks, the latest of each reference level. Labels are placed by priority --
trade, structure breaks, sweeps, liquidity, zones, levels, swings, sessions,
tags -- and one that would overlap a more important label, the HUD or the
toolbar is not drawn.

---

## Not built

- Setup history in the database (the spec's "save every completed setup"):
  needs a table, whose schema waits for the owner's go-ahead. Until then the
  record is recomputed from the candles on screen, which is deterministic.
- BPR, liquidity voids, RSI divergence, internal vs external structure.
- Live-only confirmations (the early warning's OI / CVD / book reads, the
  options flow): recorded only since Sep 2026, so there is no history to test
  them on yet. See TODO.md.
- Same-candle stop and target resolved from 1m candles (today: stop first).
