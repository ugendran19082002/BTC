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
sell-side liquidity swept          FORMING    (24 candles to shift, or expired)
  → bullish CHoCH / BOS
  → POI: the break's OB, else a bullish FVG since the sweep
                                   READY      (plan fixed now; 30 candles to fill)
  → retest fills at the POI's top  ACTIVE
  → TP1 / TP2 / TP3, or the stop   (96 candles, then a time exit)
```

Short is the mirror. The plan, fixed at READY and never moved:

- **Entry** -- the POI's proximal edge, as a resting limit.
- **Stop** -- beyond both the sweep's extreme and the POI, plus 0.1 ATR. A stop
  wider than 4 ATR is not taken.
- **Targets** -- liquidity and levels already on the chart beyond the entry,
  nearest first, **each at least 1R**; R multiples fill in only where there is
  no liquidity.
- **Management** -- a third off at each target; the stop to break-even after
  TP1 (recorded as an event). A stop before TP1 is -1R; TP1 then back to entry
  banks a third of TP1's R.

Inside one candle the stop is checked before the targets, and on the fill
candle no target is awarded and the favourable excursion is taken at the
close: a candle does not say which of its extremes came first, and the record
is not allowed to guess in its own favour.

**Context gate.** A setup against the 30M bias or the 15M structure is shown
but called **NO TRADE**, faded, with what it runs against. The 1M and 4H do
not gate.

**The record.** The HUD counts this chart's completed trades: TP1 rate, stop
rate, average R, MFE and MAE. Each setup was decided without seeing its
future, so this is walk-forward -- but it is one chart's worth of candles, and
the count is printed beside it for that reason.

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
  options flow) as setup confirmations: see TODO.md.
