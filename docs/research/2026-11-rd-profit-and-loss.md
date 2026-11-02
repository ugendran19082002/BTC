# R&D: more profit, less loss — exits, re-entry, windows, methods, delta (1 Oct – 1 Nov 2026)

Written 2 Nov 2026, after two days of studies the owner asked for ("same loss profit increase, profit increase loss decrease,
same profit loss decrease ... time, entry, exit, SL, perp SL, delta, choosing methods, win %, auto-update ... ellaam R&D pani
best kandu pidi"). It records what was tested, how, the numbers, what went live, and what was waste, so that the review on
9–10 Nov 2026 has its reference and nobody re-runs a study that is already answered.

All money is **₹ per 1 contract** (0.001 BTC), after Delta's charges (3.5% of premium + 18% GST, each fill), at ₹85 per $.
"Halves" are 1–16 Oct and 17 Oct – 1 Nov. "w/o 13+30" is the result with 13 Oct and 30 Oct (the two spike days) left out.
A result marked ✓ is no worse than the comparison in both halves and without 13+30.

## The short version

- **Went live on 2 Nov 2026** (each validated, rehearsed on a copy of the database, applied in one guarded transaction,
  cross-checked): the A6 no-entry windows on all 4 accounts; 3m and 5m perp SL minimum 150 on all accounts; delta 0.12 from
  07:00 and 0.09 from 11:00 on every strategy; all time (chain) perp SL minimum 100 on all accounts.
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

**A6, live on all 4 accounts since 2 Nov ~15:00 IST** (windows block from `from` up to, not including, `to`):

| Strategy | No entry |
|---|---|
| 3m time, 5m time | 11:00–12:00, 13:00–14:00, 15:59–17:29 |
| 15m time, all time | 13:00–14:00, 15:59–17:29 |
| 1h time | 12:00–13:00, 15:59–17:29 |
| 30m, 2h, 4h time | 15:59–17:29 |

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
timeframes better (2h and 4h level); the gain is at 07:00 (+264) and 09:00 (+274). **Live on all 32 strategies since
2 Nov ~16:05 IST.** The 0.13 morning start is the engine's favourite but quadruples the real worst day (25 Oct); worth a
trial on one account only.

## 8. The accounts, before the windows were made the same

Real, 27 Oct – 1 Nov, per contract: High 1,371 trades +₹1,945 (+1.42 a trade, PF 2.35) · Medium 974, +₹1,593 (+1.64,
PF 2.24) · Low 1,009, +₹1,626 (+1.61, PF 2.14) · Income 134, +₹297. Medium and Low made ~85% of High's money on ~30% fewer
trades. Since 2 Nov the windows are the same on all four, so the window experiment is over; they still differ by win %
(70 / 80).

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
| Win 65%, daily update, look-back 14, all accounts | setting | §4: ~+6%, real band check positive |
| Target 95% + time stop 2 h (exit if the offer is over 150% of entry) | code + setting | §1: +12%, loss −10%, ✓ all under A6 |
| Max SL distance filter (skip 250–400 pts, chain first) | study, then setting | §6: the weak band on real fills |
| Re-entry on — Income first: SL → opposite all day max 2, target → same 07–10 max 2 | setting (UI pill) | §2 |
| Delta 0.13 from 07:00 on one account | setting, trial | §7: engine ✓, real worst day ×4 |
| Momentum guard on High, Medium, Low (+250 / 1 h, calls only) | setting | earlier study: backtest +₹837, real +₹326 |
| Daily loss limit ₹150–200 a day, every account | UI | earlier study: +₹600, loss −12% |
