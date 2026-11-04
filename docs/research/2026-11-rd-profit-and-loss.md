# R&D: more profit, less loss — exits, re-entry, windows, methods, delta (1 Oct – 1 Nov 2026)

Written 2 Nov 2026, after two days of studies the owner asked for ("same loss profit increase, profit increase loss decrease,
same profit loss decrease ... time, entry, exit, SL, perp SL, delta, choosing methods, win %, auto-update ... ellaam R&D pani
best kandu pidi"). It records what was tested, how, the numbers, what went live, and what was waste, so that the review on
9–10 Nov 2026 has its reference and nobody re-runs a study that is already answered.

All money is **₹ per 1 contract** (0.001 BTC), after Delta's charges (3.5% of premium + 18% GST, each fill), at ₹85 per $.
"Halves" are 1–16 Oct and 17 Oct – 1 Nov. "w/o 13+30" is the result with 13 Oct and 30 Oct (the two spike days) left out.
A result marked ✓ is no worse than the comparison in both halves and without 13+30.

## The short version

> **2 Nov evening: every setting changed below was put back to the morning's** (owner's call, after the before/after
> backtest: +15% profit in the fair half, loss +67%, loss days 5 → 12). The findings stand as findings; none of them is
> live now. Re-entry (switched on from the screen on 1 Nov) is the only change of these two days still running.

- **Went live on 2 Nov 2026** (each validated, rehearsed on a copy of the database, applied in one guarded transaction,
  cross-checked): the A6 no-entry windows on all 4 accounts, tuned the same evening to A7 (§3); 3m and 5m perp SL minimum 150 on all accounts; all time (chain)
  perp SL minimum 100 on all accounts. Delta 0.12 from 07:00 and 0.09 from 11:00 went live at ~16:05 IST and was put back
  to the old schedule the same evening at the owner's word (§7).
- **Built, off until switched on:** re-entry after an option SL (the other side) and after an option target (the same
  side), each with its own time range (1 Nov 2026). Best: SL → opposite 07:00–17:29, max 2; target → same 07:00–10:00, max 2.
- **Next, not yet done:** win 65% with a daily method update; target 95% + a 2-hour time stop (needs code); a "max SL
  distance" filter (the 250–400 pt band is the weak one); switching re-entry on (Income first).
- **Waste — do not test again:** perp SL (every variant, once A6 is in), no option SL or very wide SL, breakeven moves,
  trailing stops, earlier exit times, targets below 90%, delta by volatility, session switches at 13:30, flat delta 0.10 or
  less, re-selling the same side after an SL, the opposite side after a target, one no-entry window for every timeframe.

## How it was measured

Three readings, because each one alone misleads:

1. **Real-path replay.** Every real entry 1 Oct – 1 Nov (9,456 strategy trades from `trades`) is replayed on its own
   option's real price path — `option_snapshots_1m` from 13 Oct 10:55 IST, the 5-minute `option_snapshots` before — under
   other exit rules: SL when the offer reaches the stop, target when it reaches the target, else the 17:29 exit at the
   offer. Calibrated: the current rules replayed give **+₹7,651** against **+₹7,081** really made on the same trades.
   For a different strike (delta, re-entry) the strike is re-picked on the real chain at that minute (highest |delta| at or
   under the target, sold at the bid, skipped below the $13 floor, as the desk does).
2. **Walk-forward engine backtest.** The desk's own backtest (`signalBacktestTradesHere`) run day by day, 19 Sep – 1 Nov,
   on a draft of each live strategy with **every method** and the auto-update off; the daily method pick (win %, least
   trades, look-back, every N days) is then replayed in Python exactly as `pickMethods` does, each day picking only from the
   days before it. Filters (no-entry windows, SL minimum, premium floor) are applied to the pick's record and to the trades
   alike, as the live update does. No account cap is modelled, so it is **optimistic** (PF ~3.5 against ~2 real) —
   trust its rankings, not its rupees.
3. **Real fills by band.** The real trades grouped by the thing under test (entry hour, SL distance, premium, the method's
   prior win %) to check that the backtest's direction holds on what really happened.

The engine runs were made on a disk-backed copy of the live database (`postgres:17-alpine` as `btc-rt-study`, port 5434,
`--memory 1g`, filled by `pg_dump -Fc | pg_restore`, removed after each study) — never the live database and never the
tmpfs test database. Live reads used `PGOPTIONS='-c default_transaction_read_only=on'`.

## 1. Exits (real-path replay, 9,456 real entries)

| Variant | NET | vs current | Loss vs current | PF | Worst day | Verdict |
|---|--:|--:|--:|--:|--:|---|
| **Current** (SL 250%, target 80→90% steps, 17:29) | +7,651 | – | – | 1.57 | −2,052 | |
| SL 100% | +8,049 | +398 | −24% | 1.78 | −730 | profit from 13/30 Oct only (w/o: −1,380) |
| SL 150 / 200 / 300% | +7,273 / +7,123 / +7,159 | −377 / −528 / −492 | | | | ✗ |
| SL 400% | +10,214 | +2,564 | −8% | 1.82 | −3,617 | worst day ×1.8 |
| SL 900% | +11,858 | +4,207 | −14% | 2.03 | **−5,798** | tail risk |
| No SL | +17,430 | +9,780 | | 3.80 | −1,358 | October's spikes reversed; unbounded risk — **not used** |
| Target fixed 60–85% | | −818 to −5,975 | | | | ✗ |
| Target 95% (A) | +8,739 | +1,089 | +5% | 1.62 | −2,669 | mixed alone |
| Exit 13:00–17:00 | | −11 to −2,662 | | | | ✗ |
| Breakeven (any) | | −297 to −2,469 | | | | ✗ |
| Trailing (low ×2/3/4) | | −561 to −1,870 | | | | ✗ |
| Time stop 2 h, exit if offer > 150% (B) | +8,005 | +354 | −10% | 1.66 | −1,583 | ✓ halves |
| **A + B** | **+9,209** | **+1,558 (+20%)** | **−6%** | 1.72 | −2,201 | ✓ all |
| A + B + perp SL at stop +100 | +8,946 | +1,296 | −31% | 1.96 | −1,582 | before A6 only |

Max adverse excursion: the offer reached 3.5× the entry on 14.9% of trades, 10× on 4.1%, 30× on 0.2% (worst 46.7×).

**Under today's config (A6 windows, 7,158 entries)** the same replay gives: target 95% + time stop 2 h **+₹1,291 (+12%),
loss −10%, worst day −24 against −84, ✓ all** — the only exit change that passes every check. Needs a "time stop" rule in
code; not built yet.

### Perp SL (the signal's stop on the perp) — waste once A6 is in

Before A6 (all hours), perp SL at the signal stop kept profit (+234) and cut loss 39%, because it caught the bad
afternoons. With A6 those hours are already blocked; on the 7,158 A6 entries every one of 21 variants costs money:

| Variant | NET vs current | Loss |
|---|--:|--:|
| At the signal stop | −1,636 | −35% |
| +50 / +100 / +200 / +300 pts beyond | −1,161 / −1,136 / −903 / −490 | −34% / −29% / −24% / −19% |
| −50 pts (tighter) | −2,519 | −35% |
| +25% / +50% of the distance | −1,246 / −1,011 | −30% / −27% |
| Confirmed 2 min / 5 min | −1,269 / −1,033 | −36% / −34% |
| CE only / PE only | −187 / −1,449 | −35% / 0% |
| Fast tf only / slow tf only | −881 / −756 | −22% / −13% |
| After 30 min / first 2 h only | −1,580 / −948 | −33% / −28% |
| + option SL 400% (at stop / +100) | −865 / −333 | −44% / −38% |

When the perp SL really was on (early October), the 1,229 trades it closed made −₹3,055; held on today's rules they would
have made −₹3,006. It saved nothing. **Keep `skipPerpSl` on.**

## 2. Re-entry after an option exit (built 1 Nov, off)

Every real option SL and target 1 Oct – 1 Nov followed by another sale on the real chain (desk on those days: 9,456 trades,
+₹7,081).

| Rule | Max | Re-entries | NET added | Win % | SL hits | Halves | w/o 13+30 | Days +/− |
|---|--:|--:|--:|--:|--:|---|--:|---|
| SL → opposite, 07:00–17:29 | 1 | 578 | +1,208 | 93% | 42 | +158 / +1,050 | +195 | 11/2 |
| **SL → opposite, 07:00–17:29** | **2** | 613 | **+1,257** | 93% | 42 | +166 / +1,092 | +244 | 11/2 |
| Target → same, 07:00–10:00 | 1 | 1,140 | +3,997 | 98% | 25 | +249 / +3,749 | +1,582 | 20/0 |
| **Target → same, 07:00–10:00** | **2** | 1,229 | **+4,465** | 98% | 25 | +249 / +4,216 | +1,595 | **20/0** |

A third in a row never came in either (the time range and the $13 floor stop it). The second target re-entry had no stop
and +₹468, all but ₹13 of it on 30 Oct.

Time range (13–31 Oct, max 2):

| SL → opposite | NET | | Target → same | NET | SL hits | w/o 30 Oct |
|---|--:|---|---|--:|--:|--:|
| **all day** | **+1,129** | | **07–10** | **+4,311** | 25 | **+1,478** |
| 07–11 | +834 | | 07–11 | +5,360 | 116 | +1,162 |
| 11–17:29 | +251 (95% won) | | 07–12 | +5,507 | 171 | +801 |
| 07–15 | +1,125 | | all day | +5,986 | 480 | +952 (13–21 Oct −908) |

Rejected: the same side again after an SL (13 Oct: −₹342, 46 of 57 stopped); the opposite side after a target (+₹445, the
morning lost).

## 3. No-entry windows

High's real fills, 07:00–15:59, by hour (₹): 07 +1,624 · 08 +632 · 09 +722 · 10 +192 · 11 +44 · 12 +6 · 13 +57 · 14 +130 ·
15 +34. The hours that lose differ by timeframe: 3m and 5m at 11 and 13, 15m and chain at 13 (13:30–13:59 lost in both
halves on every reading), 1h at 12, 30m/4h nowhere.

| Proposal (High's real fills) | NET vs now | Loss | PF | Worst day | Without its best day |
|---|--:|--:|--:|--:|--:|
| High as it was (15:59+) | +3,442 | – | 1.93 | −165 | |
| A per timeframe (first) | +207 | −22% | 2.26 | −105 | +23 |
| **A6** (robust hours only) | **+195** | **−14%** | 2.13 | −156 | **+77** |
| One window for all: 11–12 + 13–14 | −101 | −25% | 2.19 | −133 | |
| Income's (11–13) | −51 | −20% | 2.14 | −86 | |
| Low's (11+) | −272 | −40% | 2.43 | −117 | |
| 13–14 for every tf | −57 | −12% | | | −172 |

Two warnings that matter: choosing the blocked hours on one half and scoring them on the other **lost ₹172** (fitted windows
do not carry over), and day by day every proposal was better on fewer days than worse (A: 11 better, 17 worse) — a window
is insurance against 2–3 bad afternoons a month (14, 19, 21, 26 Oct), not an edge. A6 keeps only the hours that lost on
every reading.

**A6, live on all 4 accounts from 2 Nov ~15:00 IST, replaced the same evening by A7** (below). Windows block from `from`
up to, not including, `to`:

| Strategy | No entry |
|---|---|
| 3m time, 5m time | 11:00–12:00, 13:00–14:00, 15:59–17:29 |
| 15m time, all time | 13:00–14:00, 15:59–17:29 |
| 1h time | 12:00–13:00, 15:59–17:29 |
| 30m, 2h, 4h time | 15:59–17:29 |

### A7: A6 tuned to the half-hour (live on all 4 accounts since 2 Nov evening)

Every half-hour from 10:00 to 15:59, for every timeframe, blocked on top of A6 or opened from it (144 tests), scored by the
walk-forward engine (4 accounts) and High's real fills. Kept only the changes that gained on both, in both halves and
without 13+30: 3m opens 11:30–12:00 and 13:00–13:30; 15m opens 13:00–13:30; 1h opens 12:00–12:30; 5m and 2h block
14:00–14:30. Nothing else at 10:00, 12:00 or 15:00 helped; 30m and 4h want no window.

| Strategy | A7 no entry |
|---|---|
| 3m time | 11:00–11:30, 13:30–14:00, 15:59–17:29 |
| 5m time | 11:00–12:00, 13:00–14:30, 15:59–17:29 |
| 15m time | 13:30–14:00, 15:59–17:29 |
| all time | 13:00–14:00, 15:59–17:29 |
| 1h time | 12:30–13:00, 15:59–17:29 |
| 2h time | 14:00–14:30, 15:59–17:29 |
| 30m, 4h time | 15:59–17:29 |

| Windows | Engine vs A6 | Engine loss | Real (High) vs A6 | Real loss |
|---|--:|--:|--:|--:|
| **A7** | +1,181 (+2%) | +2.6% | +127 (~+4%) | −1.8% |
| No windows (15:59 only) | +1,548 | +25.5% | −195 | +15.9% |
| Low's old 11:00+ | −5,698 | −26% | −460 | −30.5% |

Caution: chosen on the same month; on the real fills almost all of A7's gain is in 17 Oct – 1 Nov (1–16 Oct ≈ 0). The
review should score each half-hour change on November's fills before trusting it further.

### Where the day ends (no entry from …)

| From | Backtest vs 15:59 | Loss | Real (that 15 minutes) |
|---|--:|--:|---|
| 14:00 / 15:00 / 15:30 | −268 / −52 / +4 | −11% / −3% / −1% | 15:30–15:45: −₹38 |
| **15:59** | – | – | |
| 16:15 → 17:29 (none) | +470 → +519 | 0% | 16:00 on: 20 trades in the month |

Kept at 15:59: nothing earlier pays, and the later gain rests on a backtest with almost no real trades behind it.

## 4. Methods: win % and how often the list is picked

Walk-forward, A6 on every account, 4 accounts added. The current update (70% High / 80% the rest, every 14 days, look-back
14) against others. 1–16 Oct is distorted (a 14-day pick started on thin September history), so the fair half is
17 Oct – 1 Nov:

| Pick (look-back 14) | 17 Oct – 1 Nov vs current | Loss (whole month) |
|---|--:|--:|
| Win 80, daily | +618 | |
| Win 70, daily | +1,272 | |
| **Win 65, daily** | **+1,589 (~+6%)** | ~+1% (10 Oct – 1 Nov run) |
| Win 65, every 7 / every 14 | +1,604 / +1,111 | |
| Win 60 / 50, daily | +1,612 / +1,909 | |
| Every method | +2,571 | |

The earlier 10 Oct – 1 Nov run gave the same order: win 65 daily +₹2,679 (+5%) over 4 accounts, every account better in
both halves. On **real fills**, methods whose prior-14-day backtest win % was 65–80% made +₹252 on 275 trades — per trade
the same as the 80%+ methods (+0.71 to +1.36 against +0.77) — so lowering the bar to 65 lets in nothing worse. Below 65
there is too little real data to say. **Not applied yet.**

## 5. Premium floor

| Floor | Backtest vs $13 | Loss | Real per trade in that band |
|---|--:|--:|---|
| $5 / $10 / $12 | −2,783 / −346 / +99 | +24% / +11% / +2% | $0–13: +0.03 to +0.23 |
| **$13** | – | – | $13–14: +0.24 |
| $14 / $15 | +157 / −130 | −4% / −6% | $14–15: −0.37 |
| $20 / $30 | −2,428 / −8,818 | −14% / −41% | $30+: +1.71 |

**Kept at $13.** Lower adds near-breakeven trades and margin; higher drops good ones.

## 6. Perp SL minimum (the signal's SL distance)

Backtest, one minimum for every timeframe (now = the live mix before 2 Nov's chain change):

| Minimum | Trades | NET | vs now | Lost | Win % | PF | Worst day |
|--:|--:|--:|--:|--:|--:|--:|--:|
| 0 | 75,410 | +101,438 | +50,673 | −52,292 | 91.2% | 2.94 | −1,294 |
| 100 | 45,669 | +70,160 | +19,394 | −31,206 | 91.9% | 3.25 | −259 |
| **now** | 29,609 | +50,765 | – | −19,932 | 92.6% | 3.55 | −43 |
| 200 | 21,754 | +38,060 | −12,706 | −15,347 | 92.3% | 3.48 | −54 |
| 300 | 11,250 | +22,527 | −28,239 | −7,253 | 93.6% | 4.11 | −149 |
| 500 | 4,673 | +11,939 | −38,826 | −2,026 | 96.4% | 6.89 | −27 |

The backtest always prefers less (every extra trade looks profitable there). The real fills decide it — per trade by
distance, all timeframes: 0–100 +1.20 · 100–150 +1.29 · **150–200 +1.26** · 200–250 +0.97 · **250–300 +0.45 · 300–400
+0.56** · 400+ +1.53. Near stops are not worse; the 250–400 band is the weak one (chain loses there: −₹165 on 284 trades).

| Timeframe | Real per trade 100–150 / 150–200 | Live now |
|---|---|--:|
| 3m | +2.11 (49) / **+2.22 (165)** | **150** (2 Nov; High and Medium were 200) |
| 5m | +2.37 (35) / **+1.70 (113)** | **150** (2 Nov) |
| all time (chain) | +2.12 (19) / +1.89 (132) | **100** (2 Nov, owner's call; thin data under 150) |
| 15m | +0.44 (47) / +1.07 (171) | 150 |
| 30m | +1.07 (31) / +0.19 (145) | 200 |
| 1h | **−0.49 (18)** / +0.58 (82) | 250 |
| 2h | **−1.49 (5)** / −0.44 (23) | 250 |
| 4h | – | 300 |

By account cap (100 to 350 open): [2026-11-perp-sl-min-by-cap.md](2026-11-perp-sl-min-by-cap.md) — at the live caps
(155–170) lower minimums stop paying for 3m, since the extra trades take slots from better ones.

## 7. Delta

Real-path replay (7,137 real entries under today's config) and the engine (live pick; win 65 daily):

| Schedule | Real NET vs current | Real loss | Real worst day | Engine (live / win 65) |
|---|--:|--:|--:|---|
| **Current** 0.11 → 0.09 @11 (15m/2h 0.12 → 0.10) | +10,508 | – | −59 | – |
| flat 0.14 / 0.13 / 0.12 | +1,774 / +1,319 / +1,064 | +55% / +32% / +11% | −290 / −220 / −48 | −671 / −921 / −118 (live) |
| **0.12 → 0.09 @11** | **+713 (+7%)** | **+4%** | **−53** | −168 / +1,133 |
| 0.12 → 0.10 @11 | +742 | +8% | −48 | −399 / +308 |
| 0.13 @07 → 0.11 @09 → 0.09 @11 | +631 | +12% | −230 | **+3,250 / +3,971** ✓ |
| Session: Asia 0.12 → Europe 0.10 @13:30 | +941 | +9% | −48 | −842 / +289 |
| 0.11 → 0.09 @10 / @12 | −392 / −182 | | | −2,245 / −1,572 |
| flat 0.10 / 0.09 / 0.07 | −1,514 / −2,358 / −3,674 | | | −7,241 / −10,873 / −20,302 |
| Delta by volatility (IV or ATR, 4 sets) | – | | | **−7,847 to −12,141** |

0.12 → 0.09 against current on real paths: better on 24 of 31 days, worse on 4; every account, both sides, 6 of 8
timeframes better (2h and 4h level); the gain is at 07:00 (+264) and 09:00 (+274). It went live on all 32 strategies at
~16:05 IST on 2 Nov and was **put back the same evening** (owner: "delta old keep panu"): in the walk-forward engine it
was −₹168 with the loss +15%, all of it one day (15 Oct, −₹1,528; without it +₹1,360), while the real-path replay had it
+₹713 and better on 24 of 31 days. Live is the old schedule again: 0.11 → 0.09 at 11:00, 15m and 2h 0.12 → 0.10. The 0.13 morning start is the engine's favourite but quadruples the real worst day (25 Oct); worth a
trial on one account only.

## 8. The accounts, before the windows were made the same

Real, 27 Oct – 1 Nov, per contract: High 1,371 trades +₹1,945 (+1.42 a trade, PF 2.35) · Medium 974, +₹1,593 (+1.64,
PF 2.24) · Low 1,009, +₹1,626 (+1.61, PF 2.14) · Income 134, +₹297. Medium and Low made ~85% of High's money on ~30% fewer
trades. Since 2 Nov the windows are the same on all four, so the window experiment is over; they still differ by win %
(70 / 80).

## 9. New ideas, 2 Nov evening (real fills, 9,456 trades, 1 Oct – 1 Nov)

Each a filter or sizing applied to the real trades as they happened (the live caps 165/160/185/185 re-applied where it
matters). Baseline: NET +₹7,081, lost −₹11,220, win 78.0%.

| Idea | NET vs now | Loss | Checks | Verdict |
|---|--:|--:|---|---|
| **No CE sold after BTC rose 150+ in 60 min** (the momentum guard at 150, not 250) | **+1,213** | **−16%** | ✓ halves, ✓ w/o 13+30 | **keep** |
| Same at 250 (the guard as built) | +616 | −10% | w/o 13+30 −22 | weaker |
| Same for puts after a 150 fall | −374 | −2% | ✗ | waste (as the guard's study found) |
| **+ daily loss limit ₹50 / 100 / 150 / 200 a day per account** | **+1,651 / 1,418 / 1,328 / 1,358** | **−31% / −25% / −23% / −21%** | ✓ all | **keep** |
| **+ entries 07:00–10:00 at 2× (under the caps)** | **+4,620** | **±0%** | ✓ all, 25 of 31 days better | strong; needs a 2nd trade per signal in the morning |
| Same, 2× only 07:00–09:00 | +3,571 | −5% | ✓ all | |
| Pause a side 10–120 min after an SL on it | −110 to −351 | −1 to −7% | ✗ | waste |
| At most 3–20 open on one strike | −1,262 to −5,427 | | ✗ | waste |
| Skip wide spreads (>5–20% of mid) | −243 to −3,816 | | ✗ | waste |
| At most 1–5 entries a strike in 5 min | −3,278 to −5,802 | | ✗ | waste |
| Daily profit lock ₹200 / 400 | −2,305 / −1,659 | | ✗ | waste |
| Skip premium / hours-left < $2–6 | +11 to −4,823 | | ✗ | waste |

More ideas the same evening (real fills, or the current rules replayed on the real entries where a price path is needed):

| Idea | NET vs now | Loss | Checks | Verdict |
|---|--:|--:|---|---|
| **Target steps as now to 12:00, then 95%** (replay) | **+619** | +1% | ✓ all | **keep** — a settings change (the exit steps) |
| Target 80% to 10:00, 95% after (replay) | +608 | +1% | ✓ all | same idea |
| **Skip strikes nearer than 748 pts to spot** | +140 | **−18%** | ✓ all | keep — mostly 13:00–15:00 entries (gamma); needs a minimum distance in the delta rule |
| Skip strikes nearer than 900 pts | +5 | −33% | halves ±0 | |
| Enter 1–5 min after the signal, at that bid (replay) | −914 to −1,584 | 0 to +5% | ✗ | waste: enter at once |
| Target 95% to 12/13:00 then 80/85% (replay) | −528 to −1,700 | | ✗ | waste |
| Re-entry only while BTC still moves its way (5–30 min, 0–100 pts) | −20 to −2,857 | less | ✗ | waste; on 2 Nov it cut the target re-entries' −₹271 only to −₹169 |
| Skip a method whose real P&L over the last 3–10 days < 0 | −1,560 to −2,278 | −20% | ✗ | waste |
| A strategy stops for the day after −₹5 / −₹10 | +259 / +253 | −19% / −15% | 2nd half ✗ | not yet |
| Signal score, reward/risk, volZ, volumeZ, autocorr, efficiency, OI shift (fifths) | — | — | no band lost in both halves | waste |
| Today's range / yesterday's 0.27–0.44 | +2,003 if skipped | −37% | 28 and 30 Oct only (−₹494 without the worst day) | rejected: luck |
| Many same-side entries in the 10 min before (12+) | +₹2.06 a trade against +0.25–0.52 | | 2nd half only | an observation |

The app's daily loss limit (`daily_loss_limit_usd@<acct>`, switched by `daily_loss_limit_on@<acct>`) refuses an order whose
worst case to its stop would take the day's realised loss past the budget — a little earlier than the study's "no entry once
the day's closed loss reaches it", so the real effect is at least as strong.

### Option SL by side (replay of the real entries, 1 Oct – 1 Nov, and 2 Nov)

Calls (CE) and puts (PE) behave differently: a call that goes against us rarely comes back, a put often does. One SL for
both (250% now) is too wide for calls and too tight for puts. Current replay: NET +₹7,651, lost −₹13,513, worst day −₹2,052.

| CE SL / PE SL | NET vs now | Loss | Win % | Worst day | Halves | w/o 13+30 | 2 Nov |
|---|--:|--:|--:|--:|---|--:|--:|
| 50% / 400% | +2,281 | −33% | 75.7 | −1,096 | +775 / +1,506 | +164 | −253 |
| 75% / 400% | +2,008 | −27% | 78.3 | −1,241 | +890 / +1,119 | +324 | +175 |
| **100% / 400%** | **+1,865** | **−22%** | 80.5 | −1,347 | +1,055 / +809 | +567 | **+199** |
| 100% / 600% | +1,951 | −21% | 81.3 | −1,746 | +828 / +1,123 | +977 | |
| **150% / 400%** | **+1,188** | **−13%** | 83.3 | −1,555 | +968 / +219 | +509 | **+237** |
| 150% / 400% + target 95% after 12:00 | +1,943 | −13% | 83.3 | −1,543 | +1,191 / +752 | +1,152 | |
| 150% / no PE SL | +3,153 | −24% | 85.9 | −909 | +3,055 / +98 | +1,113 | |
| 250% / 400% | +1,016 | −4% | 87.8 | −2,279 | +842 / +174 | +1,217 | |
| CE wider than PE (350% / 250%) | +1,050 | −2% | 88.7 | −3,164 | −853 / +1,903 | +769 | |
| 25% / 400% | +1,310 | −41% | 67.1 | −996 | | −1,317 | |
| any CE / PE 250–350% | +992 to +1,527 | | | | | ✗ | |

Verdict: **CE 100–150%, PE 400%** — every check ✓ and both positive on 2 Nov; with the afternoon target 95% it is the
best combination found (+₹1,943, loss −13%). CE 50–75% won more in October but lost on 2 Nov and makes many more stops
(each a chase at the offer, which the replay does not charge). "No PE SL" is a one-half result and leaves a crash day
open: keep a PE stop. Needs code: one `stopLossPct` per strategy today, no side split.

### Option SL × target by timeframe (perp SL and perp target off, as live)

Live already skips both perp exits (`skipPerpSl`, `skipPerpTgt` on all 32 strategies). Grid on the real entries: option SL
50–1000% or none × 8 target rules (steps 80→90 now, fixed 70–95%, steps then 95% after 12:00, steps 85→95), per desk,
side, timeframe, timeframe × side and method; chosen on October, checked on 2 Nov.

- **No option SL wins every group** (desk +₹11.7k, loss −52%) only because October's spikes came back. If they had held,
  13 Oct alone would have cost −₹14,682 with no SL, against −₹3,204 at 250% and −₹4,626 at 400%. Rejected, as in §1.
- **With the SL capped at 400%, one wide SL for the desk fails** (400% + 95%: +₹3,803 but 1–16 Oct −341, worst day −4,144).
- **Per timeframe, the bounded best:** 3m and 5m SL 400% + target 95% (+₹1.0k each, loss −30%); 30m and chain 400% + 95%
  (+₹727, +₹575); 15m 250% + steps 85→95 (+₹279); 1h 100% + 95% (+₹297, but −54 on 2 Nov); 2h and 4h ≈ no gain.
  Per timeframe × side: CE wants tight (50–150%) on 15m, 1h, 2h, 4h, and wide (400%) on 3m, 5m, chain; PE wants 400% almost everywhere.
- **Out of sample (pick on one half, score the other) the fitted rules do not hold:**

| Rule chosen (SL ≤ 400%) | fit 1–16 Oct → 17 Oct–1 Nov | fit 17 Oct–1 Nov → 1–16 Oct | fit Oct → 2 Nov |
|---|--:|--:|--:|
| One rule for the desk | +408 | −341 | +373 |
| Per side | +1,022 | −341 | +344 |
| Per timeframe | +1,302 | −196 | +261 |
| Per timeframe × side | +1,572 | −139 | −111 |
| Per method | +1,639 | +175 | 0 (no method on 2 Nov) |
| **Fixed: CE 150% / PE 400%, 95% after 12:00 (not fitted)** | **+752** | **+1,188** | **+297** |

Verdict: per-timeframe and per-method SL/target tuning is fitting noise; the simple side rule above is the one that holds.

### Best methods per timeframe (option exits only, as live)

The real entries (10,148, 1 Oct – 2 Nov) replayed with the current exits and with the side exits above, then grouped by
timeframe × method. The wall methods (replenished-, pulled-, gamma-wall) and ib-fail, order-flow, options-flow, em-edge
top most timeframes; nr7, pullback, vwap-reclaim (2h) and replenished-wall (1h) are the repeat losers. But choosing
methods on that does not carry forward:

| Method filter per timeframe | Result vs keeping all |
|---|---|
| Walk-forward: keep if the last 3/5/7/14 days' NET > 0 | −₹1.5k to −₹2.4k, both exits, both halves, 2 Nov |
| Walk-forward: keep if win % ≥ 70 / ≥ 80 | −₹0.7k to −₹4.3k |
| Walk-forward: skip unproven (needs 5+ trades and NET > 0) | −₹3.5k to −₹6.7k (loss −40 to −50%) |
| Walk-forward: drop after one loss worse than −₹20 | −₹0.7k to +₹64 (noise) |
| Fixed list chosen on one half (NET > 0 / NET ≥ −₹30), scored on the other and on 2 Nov | −₹28 to −₹3.1k, every case |
| Wall methods only | −₹0.9k to −₹5.6k |

Verdict: a method's recent P&L on a timeframe does not predict its next days; keep the methods as the auto pick gives
them. (Only dropping is testable here: the real entries are already the auto pick's methods, and the room a dropped trade
frees under the cap is not modelled.) The exits, not the method list, are where the money is.


### No-entry windows, every signal (3 Nov 2026)

Every signal entered 07:00 - 17:29, 4 Oct - 3 Nov, sold at the strategies' strike (delta <= 0.10, bid >= $13), today's
exits, each timeframe's methods less its live Exclude; one contract each, no caps (Option history replay).

| Windows | Net | Loss | Worst day | Loss days | 1st half | 2nd half |
|---|---|---|---|---|---|---|
| None | +₹41,188 | ₹24,922 | −₹1,151 | 5 | +21,099 | +20,088 |
| High now (15:59+) | +₹41,017 | ₹24,836 | −₹1,151 | 5 | +21,001 | +20,016 |
| Income now | +₹38,905 | ₹20,537 | −₹1,084 | 3 | +19,176 | +19,728 |
| Medium now (11:00-11:59, 13:00+) | +₹35,574 | ₹15,832 | −₹1,041 | 2 | +17,191 | +18,382 |
| Low now (11:00+) | +₹32,351 | ₹13,148 | −₹1,172 | 2 | +15,522 | +16,829 |
| 13:00-14:00 only | +₹39,838 | ₹22,133 | −₹771 | 5 | | |
| 14:00-14:30 only | +₹41,152 | ₹24,039 | −₹1,156 | 5 | | |

- No window, single or paired (every 30-minute span, and every pair of them), adds profit in both halves: each costs some.
- 15:59+ does nothing: the $13 premium floor already leaves ~180 signals a month after 16:00.
- ₹ per signal falls through the day: 07:00 1.70, 09:00 1.50, 11:00 0.71, 13:00 0.39, 14:00 0.27, 15:00 0.07.
- Losing half-hours picked on one half and applied to the other lose money against no window (−₹200 to −₹1,200).
- Best trade-off found: 13:00-14:00 alone -- −₹1,350 a month for −₹2,789 of loss and the worst day −₹1,151 → −₹771.
  Low's 11:00+ gives up ₹8.8k for ₹11.8k less loss but leaves the worst day as it was.

## Caveats

- **One month of data.** Every number here is October 2026 — a month with two spikes that reversed (13 and 30 Oct). 30 Oct
  alone carries most of several gains (re-entry, delta 0.13+, the second re-entry).
- **The engine backtest is optimistic** (no cap, PF ~3.5 against ~2 real). Where it and the real fills disagreed, the real
  fills were followed (windows, SL minimum, perp SL, delta).
- **Windows and SL minimums were chosen on the same data they were scored on.** The out-of-sample test of windows lost
  money; A6 keeps only what held on every reading, and still expects mostly insurance, not profit.
- **The real-path replay sells at the bid and buys back at the offer each minute;** real fills chase and slip, more so in
  spikes. 13 Oct before 10:55 IST is on the 5-minute board.
- **Re-entries and extra trades need room under the cap** (150–195 now); the studies did not model it.

## Still to do

| Item | Kind | Evidence |
|---|---|---|
| ~~Method update rhythm~~ — done 2 Nov: every 5 days, look-back 5, win % 60 / 65 / 70 / 75 by account | setting | Walk-forward under the live caps (update × look-back grid): 5 on 5 +₹1,425 (+6%) in the fair half against 14 on 14, every account, loss +20%; shorter look-backs (3–7) beat 14–28; win % 50–85 made the same money, higher lost less |
| Target 95% + time stop 2 h (exit if the offer is over 150% of entry) | code + setting | §1: +12%, loss −10%, ✓ all under A6 |
| Max SL distance filter (skip 250–400 pts, chain first) | study, then setting | §6: the weak band on real fills |
| Re-entry on — Income first: SL → opposite all day max 2, target → same 07–10 max 2 | setting (UI pill) | §2 |
| Delta 0.12 (or 0.13) from 07:00 on one account | setting, trial | §7: real +7% (0.12); engine ✓ for 0.13 but real worst day ×4 |
| Momentum guard on High, Medium, Low (+250 / 1 h, calls only) | setting | earlier study: backtest +₹837, real +₹326 |
| Daily loss limit ₹150–200 a day, every account | UI | earlier study: +₹600, loss −12% |
| Option SL by side: CE 100–150%, PE 400% (+ target 95% after 12:00) | code + setting | §9: +₹1.2–1.9k, loss −13 to −22%, ✓ all, ✓ 2 Nov |
