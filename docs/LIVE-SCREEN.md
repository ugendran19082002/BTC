# The Signals screen

**Built 27 September 2026**, top to bottom, from `docs/New.md`'s hierarchy.
This document is what the screen claims, what each claim stands on, and the two
measurements that decided its shape.

> **Where it lives.** The **Signals** tab, beside the Live screen rather than
> in place of it. The Live screen is untouched — the same `Overview`, the same
> panels, the same behaviour it has always had. This is a second reading of the
> same market, built to a different rule, and the two can be compared on live
> data before anything is decided about either.

---

## The short version

There is no 100% accurate signal, and this screen is built to make that
impossible to forget. `docs/New.md` says it in its own words —
*100% accuracy இல்லை* — and the two tables this desk has measured agree with
it emphatically:

| Measurement | What it says | Where |
|---|---|---|
| `chain.db.horizons` — 105,119 windows, 364 days, 8 horizons | The share of windows closing **higher** is 49.4–50.6% at *every* horizon from 5m to 12h. Conditioning on trend (`p_up_trend`) makes it **worse**: 48.9–50.2%. | `domain/forecast.ts` |
| `research/MOMENTUM-MEASURED.txt` — 261,713 bars, 2024-04 → 2026-09 | Every stop/target policy is **net negative after fees** at every timeframe. 0 of 582 filters survived out-of-sample at 5m and 15m. After a confirmed break, price kept going only **44.8%** of the time. | `backtest/momentum-study.ts` |

**Direction is a coin flip. Magnitude is not.** A break does not predict which
way price goes; it predicts a *bigger hour* — 16% bigger at the median on 5m,
40% on 1h. That asymmetry is the only real edge in either table, and it is an
option seller's edge, not a directional trader's.

So the screen forecasts the **band** and refuses to forecast the **arrow**.

---

## The order, and why

Top to bottom, the questions in the order a person actually asks them:

```
1  VERDICT          which way, and may I act?          ← one answer, above its own argument
2  BIG MOVE         is something breaking now?         ← with SL / TGT and its measured record
   SETTLEMENT BAND  how far can it get by 17:30?       ← the cone, from measured windows
3  TIMEFRAMES       where did the verdict come from?   ← the weighted 12H → 1M ladder
   STRIKE SAFETY    are these strikes far enough?      ← against that same band
4  NOT READ         what the screen wanted and missed
```

Rows 2 and 3 are pairs on a wide screen and stack on a phone. Neither half of
either pair is subordinate to the other. The chart and the option chain stay on
the Live tab, which is where they already were.

---

## Two rules the whole screen obeys

### 1. One read, one timestamp

Everything comes from a single `GET /api/live`. The Live tab polls eight
endpoints on four different intervals, so its 12-hour row can be a minute older
than its 5-minute row and the page can contradict itself while every individual
part is correct. This screen cannot: one call, one timestamp. `asOf` is on the response and the header
prints it; past 90 seconds it says how stale it is rather than pretending.

### 2. No figure without its provenance

Every number is badged **measured**, **modelled** or **observed now**, and a
measured badge carries its sample size — "measured" over eleven windows is not
measured. An ungraded state is badged **never graded** and says so in words.

`docs/FULL-STUDY.md` §7.5 was filed against the Live tab for showing an 80%
hit rate with no cost beside it. The fix is not a tooltip: `MomentumCard`
**cannot be rendered** without the net-after-fees row, and the verdict badge is
computed from the measurement, not from the setup.

---

## 1 · The verdict

Two separate facts, never merged into one light:

- **Which way** the weighted ladder reads — `UP` / `DOWN` / `No side`.
- **Whether the desk may act** — `Entry ready` or `Not ready`, with *every*
  blocker listed as a sentence.

They are separate because a strong `DOWN` read with the 5M trigger still
pointing up is a common and important state, and one green light cannot say it.
Blockers are listed in full rather than counted: "Not ready (3)" makes a person
hunt; three sentences make them decide.

---

## 2 · The timeframe ladder

`domain/hierarchy.ts`. Nine frames, each weighted by the **job it does**:

| Tier | Frames | Weight | Job |
|---|---|---:|---|
| Direction | 12H · 6H · 1D | 3 | Where the market is going. No entry is read here. |
| Structure | 4H · 2H | 3 | Which prices matter. |
| Setup | 1H · 30M | 2 | What is forming. |
| Pattern | 15M | 3 | Whether it confirmed. |
| Trigger | 5M | 3 | Whether the move started. |
| **Execution** | **1M** | **0** | Entry timing only. |

**The 1-minute frame carries zero weight, and the zero is on screen.** This is
the entire reason the file exists. `docs/New.md` names the failure:

> Wrong approach: 1D UP / 4H DOWN / 1H DOWN / 15M UP / 5M UP —
> எல்லாவற்றையும் equal vote பண்ணுவது. … 1M bullish candle வந்ததுக்காக
> 12H bearish bias flip ஆகக்கூடாது.

The Live tab's `mtfConsensus` does exactly that — one vote per readable row,
flat majority — so five fast frames can outvote four slow ones. That is the
single clearest difference between the two screens, and the reason to compare
them on live data rather than argue about them.

Each frame votes on four of its own reads (EMA stack, RSI, swing structure,
and VWAP when price is ≥0.1% away from it — inside that it is noise and gets no
vote). The share that agreed becomes its **conviction**, which scales its
weight. A frame at 25% conviction contributes a quarter of its 3.

**Frames that disagree are named** under the table, never averaged away.

### Where the frames come from

Delta India serves `1m 5m 15m 30m 1h 2h 4h 6h 1d` natively. **It does not serve
`12h`** — the endpoint returns an empty result, measured 26 Sep 2026. So the
12-hour frame is folded from pairs of 6-hour bars, aligned to the epoch so the
boundaries land at 00:00 and 12:00 UTC — which is also where the desk's day
(05:30 IST) begins. `resampleTf` in `market/moves.ts`; asserted in
`test/market/hierarchy-frames.test.ts`.

The four new frames are **deliberately not** in `TREND_TIMEFRAMES`. That list
feeds `agreement` and `regime`, which are measured numbers, and nine frames
voting where five used to would have changed them without anyone asking.

### Readiness

Not a score threshold — a set of rules, because a single number crossing a line
is how a screen ends up saying ENTRY READY on four fast frames under a daily
downtrend:

- direction and trigger tiers must **agree**
- structure must not **contradict** them
- the weighted read must be outside the ±15% dead band
- at least one frame must have **ADX ≥ 20** — in a market with no trend, every
  level is a coin flip

---

## 3 · Big move — the momentum signal

`domain/momentum-signal.ts`. Two states, and the difference is the design:

**COILED** — range has contracted below 80% of its own recent average. Names
both edges, offers **no side and no entry**, and carries **no measured record
because none has been taken**. A contraction says a move is likely, not which
way it breaks.

**CONFIRMED** — a level broke on a closed bar. Carries entry, stop, target, and
the measured record for that exact (timeframe, policy) pair.

Levels come from `entry 1.5 ATR : 3 ATR`, not the old card's
`live (level ± 1 ATR)`: across all four timeframes the replay put the wide-stop
policy least negative, and at 30m and 1h it was the only one whose average R
before fees was positive at all.

### The verdict is drawn from the measurement, never the setup

```
TRADEABLE      only when measured net R after fees > 0
INFORMATIONAL  everything else
```

As of the 27 Sep run, **every timeframe is INFORMATIONAL**:

| TF | n | hit | net after fees | 2026 (held out) |
|---|---:|---:|---:|---:|
| 5m | 9,981 | 22.9% | **−0.612R** | −0.645R (n=2,931) |
| 15m | 2,834 | 19.2% | **−0.284R** | −0.324R (n=841) |
| 30m | 1,317 | 19.8% | **−0.149R** | −0.093R (n=375) |
| 1h | 644 | 18.2% | **−0.124R** | −0.114R (n=195) |

The card still shows the break — knowing the market just broke 84,000 is worth
knowing — but it may not present it as a trade, and there is no prop that turns
that off.

`src/domain/momentum-measured.data.ts` is **generated** by
`npx tsx src/backtest/momentum-study.ts`. It is committed, and
`test/domain/momentum-signal.test.ts` asserts it exists and is non-empty with a
message naming the command — so the failure mode that took down six suites in
`FULL-STUDY.md` §7.1 becomes one named test rather than an unreadable
module-not-found.

---

## 4 · The settlement band

`domain/expiry-path.ts`. `docs/New.md` asks for a path —
"Next 5m ↓ −45 · Expiry ↓ −550" — and in the same breath insists the numbers
come from historical calibration rather than an assumption. They do, and the
calibration refuses to draw the arrow.

So the card draws a **symmetric cone** at the measured median, 68th and 95th
percentiles, per horizon, and prints the lean beside it as the nothing it is:
*"0.62 pts from a coin flip"*.

- 5m, 15m, 1h, 2h and the settlement horizon are **measured**.
- **30m is interpolated** — the table has no 30-minute row — linearly in √t
  between 15m and 1h, because diffusion scales with √t. Interpolated rows are
  marked `~` on screen and report `windows: 0`.
- Past the table's 12-hour end it extrapolates from the last anchor by the same
  rule, and still marks itself interpolated.

The ladder decides **which edge to watch**. It never moves the band — asserted
in `test/domain/expiry-path.test.ts`.

---

## 5 · Strike safety

Three questions per strike, to settlement:

| Column | Stands on |
|---|---|
| Expires OTM | Black–Scholes from ATM IV — **modelled** |
| Touched | Reflection principle — **modelled**, and always ≥ (1 − expires OTM) |
| **× P95** | distance ÷ the measured 95th-percentile move — **measured**, no model at all |

The table sorts on × P95, and says in words that when the measured column and
the model disagree, the measured one is the one to believe. "Touched" sits
beside "expires OTM" so the gap between them is visible: that gap is the entire
risk of a short.

---

## Files

| File | What |
|---|---|
| `server/src/domain/hierarchy.ts` | The weighted ladder and the readiness rules. Pure. |
| `server/src/domain/expiry-path.ts` | The measured cone and per-strike safety. Pure. |
| `server/src/domain/momentum-signal.ts` | COILED / CONFIRMED, the plan, the verdict. Pure. |
| `server/src/domain/momentum-measured.data.ts` | **Generated.** The scorecard. |
| `server/src/market/live-read.ts` | One read, one timestamp. Composes the three. |
| `server/src/market/moves.ts` | `HIERARCHY_TIMEFRAMES`, `resampleTf`, the nine frames. |
| `server/src/http/routes/desk.routes.ts` | `GET /api/live`. |
| `web/src/components/live/` | The screen. `LiveScreen` and six cards. |
| `web/src/types/live.ts` | The shapes, mirroring the server. |

Nothing was removed. `web/src/components/overview/` and `web/src/lib/overview.ts`
are exactly as they were; the Live tab still renders them.

---

## What to measure next

1. **The coiled state has never been graded.** It is the one card on the screen
   making a claim with no number behind it, and it is labelled as such. The
   measurement: how often does a contraction below 0.8× resolve into an hour
   bigger than baseline, and by how much?
2. **The ladder's weights are New.md's ordering, not a measurement.** They are
   printed on screen so they can be argued with, but nobody has tested whether
   3/3/2/3/3/0 beats a flat 1/1/1/1/1/0 at anything.
3. **The dead band is 15% by reasoning, not by measurement.**

All three are honest gaps, stated here so they are not mistaken for settled.
