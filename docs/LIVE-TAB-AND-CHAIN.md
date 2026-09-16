# The Live tab and the chain — every number, and where it comes from

What each figure on the Live tab and the option chain actually is: the formula,
the inputs, the thresholds, and — for the ones that were measured — what the
record says. Written to be read beside the screen, so a number that looks wrong
can be traced without opening the code.

Three conventions run through all of it:

- **Absent is not zero.** A figure with no input reads `—` or `·`, never 0. A
  gate that cannot be read never passes.
- **Prices are dollars per BTC.** A contract is `0.001 BTC`, so money is
  `price × contracts × 0.001`. A premium of 15 on 1,400 contracts is $21.
- **Time is real time remaining**, `T = (expiry − now) / (365 × 24h)` in years,
  recomputed on every refresh. Nothing assumes 12 or 24 hours.
  (`chain.ts`: `tte`, `hoursToExpiry`.)

---

## 1. The board itself

| Field | What it is | Source |
|---|---|---|
| Spot | Delta's `spot_price` on the expiry's tickers | `chain.ts` |
| ATM | spot rounded to the detected strike step | `detectStrikeStep` |
| Strike step | most common gap among the 12 strikes nearest spot | `chain.ts` |
| Expiry / settles | the contract's own settlement, 12:00 UTC = 17:30 IST | `expiryTsOf` |
| T | `(expiryTs − now) / 365d`, in years | `chain.ts` |
| ATM IV | mean of the mark IVs of the legs at offset 0 | `chain.ts` |

**Expected move** — one standard deviation to settlement:

```
EM = spot × ATM_IV × √T
```

Shown as `±$X`. There is a second figure, **expected move at entry**, using a
fixed `T = 12h/365d`: what the move *would* be over a full contract if today's
volatility held. The first is the risk left; the second is the risk a fresh
entry would take.

> **The whole board is read, not a window.** `width` only decides how many rows
> the chain *table* shows. Walls, max pain, PCR and every strategy decision see
> every listed strike — see TODO.md, *The wall the strategy could not see*.

---

## 2. Per-strike columns

Sell price (`sellPrice`) is **the bid** — what a seller actually receives.
Every measured figure on this desk is built on it, because the 733-day record
was priced at the bid.

| Column | Formula / rule |
|---|---|
| OI | `oi_contracts` from the ticker |
| Vol | contracts traded today |
| ΔOI | open interest now less the reading ~1 hour ago (`oi-history.ts`); blank until two readings exist |
| V/OI | `volume ÷ open interest` — how easily you get back out |
| Δ (delta) | Black-Scholes delta at ATM IV |
| IV | the leg's own mark IV |
| OTM | `\|K − S\| ÷ S` as a percentage |
| **EM×** | `\|K − S\| ÷ expected move` — the distance that means the same thing on a quiet day and a violent one. Under 1.0 the expected move reaches the strike (marked red); 2.0+ is marked green |
| B/E | short breakeven: `K + premium` for a call, `K − premium` for a put |
| Score | the 0–100 sell score, §4 |
| Signal | the tier the score falls in, after hard rules |
| EV | expected value in dollars for the lots asked for, §3 |
| → 0 | chance it expires worthless, **corrected by history**, §5 |
| Model | `N(d₂)` before any correction |
| Ask / Mark / Bid | the book. Closing a short buys the **ask** |

### The three different senses of "goes to zero"

Kept apart on purpose (`probability.ts`) — they answer different questions and
a strike can score well on one and badly on another:

```
d₁ = [ln(S/K) + (½σ²)T] / (σ√T)      d₂ = d₁ − σ√T

Expires worthless   P = N(−d₂) for a call, N(d₂) for a put
Touches the strike  P = N((−b+μT)/σ√T) + e^(2μb/σ²)·N((−b−μT)/σ√T),  b = ln(K/S), μ = −½σ²
Reaches near zero   simulated: GBM paths, repriced each step, hit when price ≤ $0.10
```

**Worked through, on the board that prompted it.** Spot 75,820, PE short at
74,400, twelve hours to settle, 30% vol:

```
Expires worthless   96.9%   ← where it finishes
Touch               24%     ← whether it reaches 74,400 at any point on the way
Near-zero           91%     ← whether the premium collapses, so the target fills
```

These are not 4% and 24% chances of losing. A path like

```
75,820 → 75,100 → 74,400 (touch) → 74,900 → 75,600 (settles)
```

touches **and** expires worthless. Touch is the drawdown and the margin
pressure to sit through, not a second way to lose — which is why the desk
draws it, marks it when it is high, and **never refuses a strike for it**.

Two strikes can settle almost identically and live very differently:

| | Expiry OTM | Touch | Read as |
|---|---|---|---|
| A | 97% | 12% | quiet |
| B | 98% | 31% | the same ending, a harder middle |

What touch does **not** say: when it happens (five minutes in or ten hours in),
or how deep it goes. And it is a model estimate — wrong volatility, wrong
touch.

Where it is useful: beside the others, never alone. `Expiry OTM · Touch ·
Near-zero · EM× · what one expected move costs` is one row in the strike sheet
for exactly that reason.

---

## 3. Expected value

The payout model is the honest part. A mark of $12 is what the market charges
for the risk; what it is *worth* is that mark rescaled by how often strikes like
this really expire worthless:

```
expected payout per BTC = mark × (1 − real) / (1 − model)
EV per BTC              = sell price − expected payout
EV (USD)                = EV per BTC × lots × 0.001 − entry charges
```

`real` is the calibrated probability (§5), `model` is `N(d₂)`. When they agree
the payout is the mark and EV is the spread you are paid. Where history says
strikes like this expire worthless *more* often than the model does, EV rises.

**Charges** (`charges.ts`, matching Delta's statement):

```
fee  = min(0.01% × spot × contracts × 0.001,  3.5% × premium)      TAKER_FEE_RATE = 0.0001
GST  = 18% of the fee                                              FEE_CAP_FRACTION_OF_PREMIUM = 0.035
```

The 3.5%-of-premium cap is what binds on cheap options — an option that expires
worthless settles at zero and is charged nothing more.

---

## 4. The sell score (0–100)

`SCORE_WEIGHTS` in `ev.ts`. Each part is scored 0–1 against the rest of **this
board**, then weighted:

| Weight | Part |
|---|---|
| 0.25 | distance out of the money |
| 0.20 | probability it expires worthless (calibrated) |
| 0.15 | open interest, against the heaviest strike on the board |
| 0.10 | volume, against the busiest strike |
| 0.10 | implied volatility richer than the money |
| 0.10 | the credit, against the floor asked for |
| 0.10 | expected value as a share of the credit |

Tiers: **strong** ≥ 80, **candidate** ≥ 65, **watch** ≥ 50, else **avoid**.

**Hard rules come first** (`EV_RULES`). Any one failing makes the strike
`avoid` however well it scores, because a score is a ranking and these are
refusals:

```
≥ 3% out of the money · ≥ 95% calibrated chance of expiring worthless
|delta| ≤ 0.05 · volume/OI ≥ 0.10 · spread ≤ 10% of mid · last trade ≤ 30 min old
```

> Honest limitation, repeated in the code: **the weights have not been through
> the cross-period screen.** They rank strikes against each other on one board.
> They do not say a board is worth trading.

---

## 5. Calibration — the difference between the model and what happened

`calibration.ts`, built from 733 settled days. Model probabilities are bucketed
and each bucket carries the frequency actually observed:

```
adjusted = the observed rate for the bucket this model probability falls in
gap      = (observed − model) × 100, in percentage points
```

Only comparable when the horizon is comparable: **8–16 hours to expiry**
(`horizonComparable`). Outside that the board says so rather than quoting a
number measured on a different kind of day. A second table asks the same
question of *distance in expected moves* rather than of delta.

---

## 6. Structure — what the board is saying

`structure.ts`. All description; none of it is wired into the recommendation,
because none of it survived the cross-period screen.

| Figure | Formula |
|---|---|
| CE / PE wall | the strike with the most open interest on that side, over the whole board |
| PCR (OI) | total put OI ÷ total call OI |
| PCR (volume) | the same over volume |
| Gamma wall | the strike with the largest `Σ gamma × OI` across both sides |
| Max pain | the strike where the total payout to option holders is smallest |
| OI range | put wall → call wall, with its width in dollars and as % of spot |
| IV skew | put IV − call IV at roughly 25 delta, in points |
| Vol premium | ATM IV − realised vol, in points; positive means options are rich |
| σ ranges | spot ± 1, 2, 3 × expected move |

---

## 7. Today's side — the five gates

`domain/direction.ts`. **Description, not instruction**: the lots are still
split by the tested rule in §8. This is the reading done before trusting it,
and on most days it returns *no side*, which is the point.

**The score.** Seven inputs, each normalised to −1…+1, weighted, renormalised
over whatever could be read (a missing input is dropped, never counted as
neutral):

| Weight | Input | How it is normalised |
|---|---|---|
| 0.15 | 24-hour return | `return ÷ 2%`, clamped |
| 0.15 | daily EMA stack | 9v21 and 21v50 agreeing = ±1; disagreeing = ±0.4 |
| 0.20 | 4-hour EMA stack | same |
| 0.25 | 1-hour EMA stack | same |
| 0.10 | momentum | 1h and 15m RSI level `(rsi−50)/20` and slope `Δrsi/5`, averaged |
| 0.10 | structure | fractal swings on the 1h: higher highs **and** higher lows = +1 |
| 0.05 | VWAP | `(close − VWAP)/VWAP`, 1% = full reading |

Then damped by trend strength, from the **strongest** ADX(14) on the board:

```
factor = clamp((maxADX − 15) / (25 − 15), 0.35, 1)
score  = Σ(weight × value) / Σ(weight) × factor
```

Agreement in a market going nowhere is agreement about noise. `|score| ≥ 0.45`
names a side.

**The gates.** Four of five must pass; a gate that cannot be read is never a
pass:

1. **Market direction** — `|score| ≥ 0.45`
2. **Timeframes agree** — 1D, 4H, 1H, 15m: at least 3 of 4 (or all but one) the
   same way, and the same way as the score
3. **Strikes clear the expected move** — nearest short ≥ 1.0 × EM away
4. **Option structure** — the two shorts straddle spot
5. **Execution and hedge** — worst spread ≤ `DEFAULT_LIMITS.maxSpreadPct` (15% of mid, the gate the order itself runs), and a hedge where one
   was wanted

**Containment**, for a two-sided seller — the number the whole trade turns on:

```
P(low < S_T < high) = N(d₂ at low) − N(d₂ at high)
```

Not the two one-sided probabilities multiplied: they are two views of one
distribution, not independent events.

**Not in the score, deliberately:** cumulative delta and funding/basis. The
desk fetches neither the aggressor side of trades nor the perpetual. A number
that looks like order flow and is not would be worse than the gap.

---

## 8. The recommendation — the part with a record

`recommend.ts`. This is the tested rule, and the only thing on the desk allowed
to change what is sold.

**Directional lean** (`directionalLean`): 24-hour return past ±2%, *or* a
smaller move the daily EMA stack confirms. Otherwise **0 — no lean**, which is
most days.

**The split**: 70/30 toward the safer side when there is a lean, 50/50
otherwise, floor 2 and cap 8 lots a side. Three calculated alternatives were
tried and lost — weighting by measured edge made more money and took a worst
day nearly twice as large.

**Per side**: strike by premium rule, credit at the bid, charges, hedge
`hedgeGap` **listed strikes** away (not a fixed dollar gap — Delta lists $200
near the money and $400 further out), max loss = width − net credit, breakeven,
expected profit = credit × P(both worthless) − average cost of a breach, and
return on the margin it ties up.

**Both legs worthless**: `1 − P(call breached) − P(put breached)` — a call
above spot and a put below cannot both finish in the money, so their product
would count a day that cannot happen.

---

## 9. Sudden move (the risk reading)

`shock.ts`, windows 5m / 15m / 1h / 4h. A 0–100 score from price velocity
against its own recent normal, volume pulse, IV change, open-interest change
and where price sits against the walls. A strategy can refuse to enter while
it is above a limit (`maxShockScore`) — a *hold*, not a refusal: the day stays
open and the next tick asks again.

The odds block under it answers "how often did a move like this carry on?"
from the record, over **the window you are looking at** — not a fixed day.

---

## 10. What is measured, and what is not

**Measured across 733 days, and trusted:**

- the $15 premium floor (a $0 floor returned $72 over the same days, $15 returned $173)
- the 2% / 70-30 directional split
- the probability calibration table
- the RSI gate
- doubling a surviving leg on a one-sided day (+36% for no more drawdown)

**On the screen, and deliberately not wired into anything:**

- open interest, walls, max pain, PCR, gamma — every attempt to *trade* them
  failed the cross-period screen
- the sell score's weights
- the direction score and its gates (§7)
- IV skew, vol premium

---

## 11. Known gaps — the research list

Things that would change a decision and are **not** implemented:

**Closed since this was written** (16 September):

- [x] **Touch and near-zero as their own columns**, and the five-figure row in
  the strike sheet (§2).
- [x] **Credit ÷ risk and a liquidity score** — in the best-trade pick (§7c).
- [x] **The hedge counts listed strikes**, not dollar steps.
- [x] **The horizon strip** (§7b): implied band, measured band, and where the
  measured distribution falls around the implied one.

Still open:

- [ ] **Stress scenarios in money**: BTC ±1/2/3% and IV ±5 points, with the
  margin at each. The strike sheet prices one expected move; that is one point
  on the curve, not the curve.
- [ ] **Credit ÷ risk as a board column**, not only on the best-trade card.
- [ ] **Premium efficiency** — `net credit ÷ distance in expected moves` — as a
  ranking figure of its own.
- [ ] **CVD and funding/basis** — needs per-trade aggressor data and the
  perpetual feed; neither is fetched.
- [ ] **Hedge availability in the gates before the strike is chosen**, so a
  side is refused for being unhedgeable rather than at the order.
- [ ] **Calibration for horizons outside 8–16 hours**, so a next-day expiry is
  scored rather than caveated.
- [ ] **The direction score's weights have never been backtested.** They are a
  starting point written down in one place so they can be measured; until they
  are, the card decides nothing.

---

*Files: `market/chain.ts`, `market/moves.ts`,
`domain/{bs,probability,calibration,ev,score,structure,recommend,direction,outlook,best-trade,forecast,shock}.ts`,
`trading/charges.ts`. Every one of them has a header comment saying why it is
the way it is; this document is the map, those are the territory.*
