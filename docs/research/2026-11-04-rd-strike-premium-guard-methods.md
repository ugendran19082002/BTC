# R&D 4 Nov 2026: perp SL minimum, CE / PE share, minimum premium, delta, momentum guard, methods

Written 4 Nov 2026 at the owner's word ("intha session nadathu research docs md file potu vai, pinnadi use aakum"), after a
day of studies run on every signal from 1 Oct. It records what was tested, how, the numbers, what went live, and what was
left alone, so the review on 9–10 Nov 2026 has its reference and nobody re-runs a study that is already answered. It
follows [2026-11-rd-profit-and-loss.md](2026-11-rd-profit-and-loss.md) (1 Oct – 1 Nov) and
[2026-11-perp-sl-min-by-cap.md](2026-11-perp-sl-min-by-cap.md).

All money is **₹ per contract** (0.001 BTC) after Delta's charges, at ₹85 per $. "Desk" is the four accounts summed.
"Halves" are named where used; "w/o 4 Nov" leaves out 4 Nov, the V-shaped day (BTC −2,270 then +2,785 points).

## The short version

**Went live on 4 Nov 2026** — each written from a fresh export, validated, rehearsed on a disk copy of the database (the
guard refusing a second run), applied in one guarded transaction, read back and diffed (nothing else changed), the API log
checked:

| ~IST | Change | Accounts |
|---|---|---|
| 17:14 | Perp SL minimum per timeframe (`signal.minSlPts`), table in §1 | High (variant C), Medium (B/C), Income (B) |
| 17:25 | Perp SL minimum, variant D | Low |
| 17:22 | No entry 17:01–17:29 only (Income's midday windows removed) — every account now the same | Income |
| ~23:30 | **Strike delta 0.12 all day** — `delta.max` and the 11:00 strike block's both 0.12 (were 0.11 → 0.09 from 11:00; 0.12 → 0.10 on 15m and 2h) | all 32 strategies |
| late | **Minimum premium $11** (`minPremiumUsd` 13 → 11) | all 32 strategies |
| late | Auto methods: 19 steady winners added to Include, 4 small losers to Exclude (§7) | all 32 strategies |

Set by the owner from the screen the same day (not by these studies): "At most open" 160 on every account; the session
loss limit 07:00–17:29 at 15% on every account (§8); the momentum guard on for High at 300 points.

**Offered, not applied:**

- Momentum guard on **calls only at 200 points on all four accounts** — +₹2,577 over 1 Oct – 4 Nov, +₹1,255 over 20 Oct –
  4 Nov, worst day better (§6).
- Caps 250 (High, Income, Low) and 200 (Medium): the owner said "I will update the cap later". The perp SL minimums of §1
  were chosen *for* those caps.
- Minimum premium $12 rather than $11: the one floor ahead of $13 in both periods (§3).

**Do not test again:**

- A guard on puts (loses at every level 100–1,000).
- Entries 17:30–07:00 (−₹16,521 over 1 Oct – 4 Nov at 0.10).
- Delta below 0.10.
- Delta above 0.12 — no more net, much more loss.
- Different deltas morning and afternoon.
- A minimum premium above $13.
- Equal CE / PE limits (50 / 50).

## How it was measured

1. **Every signal replayed.** `optionReplay` in signal mode (`app/server/src/report/option-replay.ts`), run once per
   variant in its own process on a disk copy of the live database (`btc-rt-study`, port 5434) — never the live one, never
   the tmpfs test database, one replay at a time (three at once ran the 1 GB copy out and every run died).
   - The strike: the nearest the money with |delta| ≤ `deltaMax` and a bid ≥ `minBidUsd`, at the first board after the
     fill, sold at the bid. Set per run by overriding `SIGNAL_STRIKE`, whose built-in value (0.10 / $13) **is no longer
     the desk's rule**.
   - Today's exits: option SL 250%, target 90%, perp SL and target skipped, held to the close otherwise.
   - Since commit `083b48c4` (4 Nov, 22:33) the replay caps open trades at 250 by default; studies pass `maxOpen: 10_000`.
     The most ever open at once uncapped was 2,966, so 10,000 never binds. Runs made in the minutes after that commit
     without it kept a quarter of the signals and were thrown away.
2. **One account at a time, in time order.** The replayed trades are taken as the desk would:
   - each account's own perp SL minimum;
   - at most *cap* open, each side at most 80% of it, each strategy at most 100;
   - entries 07:00–17:00 (17:01–17:29 is blocked live), 1m signals left out (chart only);
   - methods filtered by High's Exclude lists (all four accounts' lists are nearly the same). §7 uses each strategy's
     actual traded list.
3. **Judged** on the whole period, its two halves, without 4 Nov, and (§7) week by week. "Fit on one half, play the other"
   where a variant was searched for (§1).

**Read the direction, not the rupees.** On 4 Nov the replay at the day's own settings said −₹4,001; the desk really lost
−₹5,267 since 07:00 (the session loss limit's figure). The replay fills every stop exactly and sells at the bid.

**Not modelled** (unless the section says so):

- the momentum guard;
- the most on one strike (19–23%);
- re-entry (off);
- before 13 Oct the option prices come from the five-minute record, so the first days of an "1 Oct" result are rougher.

## 1. Perp SL minimum per timeframe, by cap

Owner: "cap 250, 200 frame wise ethu best SL min perp paaru high profit low loss". Every signal 20 Oct – 4 Nov, one
account's cap; a coordinate search over 0–500 per timeframe under four aims:

- **A**: most net.
- **B**: most net, loss no more than now.
- **C**: most net, worst day no worse than now.
- **D**: most net per ₹ lost.

| Cap | Variant | 3m / 5m / 15m / 30m / 1h / 2h / 4h / chain | Trades | Profit | Loss | Net | Worst day | Out of sample |
|---|---|---|---|---|---|---|---|---|
| 250 | before (all) | 200 / 200 / 150 / 200 / 250 / 250 / 300 / 150 | 5,418 | +₹10,639 | −₹5,693 | +₹4,947 | −₹1,579 | +₹4,947 |
| 250 | A | 50 / 100 / 250 / 300 / 100 / 400 / 400 / 100 | 7,662 | +₹14,275 | −₹7,768 | +₹6,507 | −₹2,336 | +₹5,848 |
| 250 | **B** → Income | 200 / 250 / 100 / 150 / 400 / 0 / 50 / 150 | 5,545 | +₹10,815 | −₹5,599 | +₹5,216 | −₹1,474 | +₹5,552 |
| 250 | **C** → High | 200 / 300 / 0 / 100 / 0 / 50 / 300 / 50 | 6,487 | +₹12,345 | −₹5,978 | +₹6,366 | −₹1,404 | +₹6,247 |
| 250 | **D** → Low | 500 / 300 / 300 / 200 / 400 / 500 / 500 / 50 | 4,383 | +₹8,440 | −₹3,492 | +₹4,948 | −₹848 | +₹3,940 |
| 200 | before (all) | 200 / 200 / 150 / 200 / 250 / 250 / 300 / 150 | 4,898 | +₹9,453 | −₹5,491 | +₹3,962 | −₹1,783 | +₹3,962 |
| 200 | **B / C** → Medium | 500 / 50 / 100 / 100 / 200 / 200 / 50 / 300 | 5,667 | +₹10,742 | −₹5,139 | +₹5,603 | −₹1,273 | +₹4,683 |

0 = no minimum. One value for every timeframe was never better than the per-timeframe sets. Low's 3m / 5m were 150 before.

## 2. CE / PE share of "At most open"

Owner: "pe ce ratio 80% iruku, cap 200, cap 250 ratio 50 to 80% test pair variants". Live is 80 / 80 (the default,
`signal_ce_max_pct` / `signal_pe_max_pct`). 20 Oct – 4 Nov, each account at its intended cap and §1 minimum:

| Account | 80 / 80 (live) | 50 / 80 | 50 / 50 | Worst day 80/80 → 50/80 | 50/80 vs 80/80 without 4 Nov |
|---|---|---|---|---|---|
| High (250, C) | +₹6,358 | +₹6,623 | +₹5,672 | −₹1,404 → −₹733 | −₹407 |
| Medium (200, B/C) | +₹5,534 | +₹5,584 | +₹4,865 | −₹1,273 → −₹741 | −₹482 |
| Income (250, B) | +₹5,137 | +₹5,512 | +₹5,086 | −₹1,474 → −₹772 | −₹327 |
| Low (250, D) | +₹4,948 | +₹4,999 | +₹4,871 | −₹848 → −₹755 | −₹41 |

Calls held to 50% win only on the V day; on every other day they skip winning calls. Puts above 80% change nothing.
**Kept 80 / 80** — the momentum guard is the tool for that day (§6).

## 3. Minimum premium $3–$20

Owner: "minimum premium test below 5 to 20 $". The floor matters only when the delta-limited strike is cheap; it is the
strike's lowest bid.

**At delta 0.10** (the rule the replay assumed then), desk, 07:00–17:00, intended caps:

| Floor | 1 Oct – 4 Nov net | vs $13 | Loss days | 20 Oct – 4 Nov net | vs $13 |
|---|---|---|---|---|---|
| $20 | +₹46,696 | −₹4,650 | 3/34 | +₹19,823 | −₹3,319 |
| $16 | +₹49,784 | −₹1,562 | 2/34 | +₹22,001 | −₹1,141 |
| $13 | +₹51,346 | — | 2/35 | +₹23,142 | — |
| $12 | +₹51,928 | +₹582 | 4/35 | +₹23,910 | +₹768 |
| $10 | +₹51,793 | +₹447 | 5/35 | +₹24,133 | +₹992 |
| $6 | +₹50,717 | −₹629 | 6/35 | +₹24,952 | +₹1,810 |
| $5 | +₹50,859 | −₹488 | 5/35 | +₹24,761 | +₹1,620 |

**At delta 0.12** (live now):

| Floor | 1 Oct – 4 Nov, intended caps | vs $13 | Loss days | 20 Oct – 4 Nov, all cap 250 | vs $13 | All cap 200 | vs $13 |
|---|---|---|---|---|---|---|---|
| $20 | +₹53,431 | −₹2,957 | 3/35 | +₹25,635 | −₹2,771 | +₹21,895 | −₹2,593 |
| $16 | +₹56,266 | −₹122 | 4/35 | +₹27,524 | −₹883 | +₹23,874 | −₹614 |
| $13 | +₹56,388 | — | 3/35 | +₹28,407 | — | +₹24,488 | — |
| **$12** | +₹56,790 | **+₹402** | 4/35 | +₹29,118 | **+₹711** | +₹25,120 | **+₹632** |
| **$11** (live) | +₹56,251 | −₹137 | 6/35 | +₹29,549 | +₹1,142 | +₹25,519 | +₹1,032 |
| $10 | +₹56,299 | −₹88 | 7/35 | +₹29,714 | +₹1,308 | +₹25,619 | +₹1,131 |
| $6 | +₹55,466 | −₹921 | 7/35 | +₹30,262 | +₹1,855 | +₹26,152 | +₹1,664 |
| $3 | +₹55,551 | −₹837 | 6/35 | +₹30,235 | +₹1,829 | +₹26,114 | +₹1,627 |

Floors under $12 win only since 20 Oct; early October's cheap premiums lost. Every step above $13 loses in both periods.
The owner chose $11; expect a few more small red days than at $13.

## 4. Strike delta

Owner: "delta check 0.15 to 0.01 ... full day, 07 to 11 ...", then "0.20 to 0.09, cap 250, 200".

**By window**, delta 0.10, $13, desk, 1 Oct – 4 Nov:

| Window | Net | Trades |
|---|---|---|
| 07:00–17:00 | +₹51,346 | 43,972 |
| 07–11 | +₹41,546 | 27,515 |
| 11–14 | +₹15,618 | 17,327 |
| 14–17:00 | +₹1,848 | 4,942 |
| 17:30–07:00 (night) | **−₹16,521** | 53,441 |
| Full 24 h | +₹13,523 | 85,346 |

The night made +₹20,922 from 20 Oct but lost about −₹37,000 over 1–19 Oct; its worst days reach −₹22,000. Do not trade it.

**By delta**, $13, 07:00–17:00, 20 Oct – 4 Nov, every account at cap 250:

| Delta | Trades | Win % | Profit | Loss | Net | Worst day | Loss days |
|---|---|---|---|---|---|---|---|
| 0.20 | 28,012 | 84.6% | +₹96,680 | −₹68,958 | +₹27,722 | −₹8,910 | 4/16 |
| 0.18 | 27,596 | 85.7% | +₹87,170 | −₹58,532 | +₹28,638 | −₹7,858 | 4/16 |
| 0.16 | 27,201 | 86.5% | +₹77,298 | −₹47,561 | +₹29,738 | −₹5,805 | 3/16 |
| 0.14 | 26,053 | 87.2% | +₹66,633 | −₹37,778 | +₹28,855 | −₹5,215 | 3/16 |
| **0.12** | 24,941 | 88.6% | +₹55,757 | −₹27,350 | **+₹28,407** | −₹4,257 | 2/16 |
| 0.11 | 24,004 | 89.1% | +₹50,445 | −₹24,346 | +₹26,099 | −₹4,191 | 3/16 |
| 0.10 | 22,956 | 89.5% | +₹44,555 | −₹20,778 | +₹23,777 | −₹3,861 | 2/16 |
| 0.09 | 21,386 | 90.0% | +₹38,242 | −₹15,909 | +₹22,333 | −₹2,685 | 2/16 |

At cap 200 the same shape: 0.12 +₹24,488 against 0.10 +₹20,689. Net flattens from 0.12 to 0.18 while the loss keeps
growing; below 0.10 is always worse; at 0.03 and less there is almost nothing to sell.

**0.12 against 0.11**, intended caps, 1 Oct – 4 Nov:

| Delta | Trades | Win % | Profit | Loss | Net | Worst day | Loss days |
|---|---|---|---|---|---|---|---|
| 0.10 | 43,972 | 89.9% | +₹86,835 | −₹35,489 | +₹51,346 | −₹3,832 | 2/35 |
| 0.11 | 45,999 | 89.1% | +₹96,515 | −₹42,617 | +₹53,897 | −₹4,109 | 5/35 |
| 0.12 | 47,855 | 88.0% | +₹106,498 | −₹50,110 | +₹56,388 | −₹4,188 | 3/35 |

Per account, 0.12 over 0.10:

| Account | 0.10 | 0.12 |
|---|---|---|
| High | +₹14,666 | +₹16,011 |
| Medium | +₹12,596 | +₹13,661 |
| Income | +₹12,449 | +₹13,740 |
| Low | +₹11,634 | +₹12,976 |

**Morning and afternoon apart** (split 12:00, one cap over the day):

| Variant | 1 Oct – 4 Nov | Loss days |
|---|---|---|
| Morning 0.12 / afternoon 0.11 | +₹56,766 | 6/35 |
| Morning 0.11 / afternoon 0.12 | +₹53,639 | 5/35 |

The 0.12 / 0.11 mix is no better than 0.12 all day. Splitting at 11:00 or 13:00 did not help. Almost all of 0.12's gain is
before 12:00.

**Against the rule that was live** (0.11, and 0.09 from 11:00; 15m and 2h 0.12 / 0.10):

| Period | Old live rule | 0.12 all day |
|---|---|---|
| 1 Oct – 4 Nov | +₹54,912 | +₹56,388 |
| 20 Oct – 4 Nov | +₹24,592 | +₹27,578 |
| 4 Nov | −₹4,556 | −₹4,188 |

**Live: 0.12 all day.** Expect win % about 2 points lower and bigger single stops (a nearer strike's premium is larger).

## 5. 4 November, the V day

527 calls were sold at 08:00 after a 2,270-point fall; BTC then rallied +2,785, about −₹5,851 from those calls.

| What | Replay result | Difference |
|---|---|---|
| Delta 0.10 | −₹4,001 | — |
| Delta 0.12 | −₹4,750 | −₹749 |
| Delta 0.11 | −₹4,109 | — |

These are at the day's own settings. Nearer strikes lose more on such a day — that is the price of their edge on the
others.

## 6. Momentum guard

Owner: "momentum guard variant test CE, PE 100 to 1000, new settings, 4 accounts, vs current".

**Settings:**
- delta 0.12 and $13;
- each account's min SL;
- "At most open" 160 each.

**The guard.** It reads the rise as the perp at the signal less its average in the minute an hour before (as
`perpHourBefore`). A call is skipped at a rise of *pts* or more. A put guard (not in the code) would skip a put at a fall of
*pts* or more.

| Guard (every account) | 1 Oct – 4 Nov | vs current | Worst day | Loss days | 20 Oct – 4 Nov | vs current | 4 Nov |
|---|---|---|---|---|---|---|---|
| Current: High CE 300, others off | +₹40,724 | — | −₹3,945 | 4/35 | +₹21,250 | — | −₹3,945 |
| None | +₹40,036 | −₹687 | −₹4,148 | 4/35 | +₹21,075 | −₹174 | −₹4,148 |
| CE 150 | +₹42,365 | +₹1,641 | −₹3,681 | 4/35 | +₹21,883 | +₹633 | −₹3,681 |
| **CE 200** | **+₹43,301** | **+₹2,577** | −₹3,559 | 4/35 | **+₹22,504** | **+₹1,255** | −₹3,559 |
| CE 300 | +₹42,338 | +₹1,614 | −₹3,464 | 5/35 | +₹21,709 | +₹460 | −₹3,464 |
| CE 500 | +₹41,699 | +₹976 | −₹3,341 | 4/35 | +₹22,076 | +₹827 | −₹3,341 |
| CE 800–1,000 | about none | — | — | — | — | — | — |
| PE 100–1,000 | +₹38,779 to +₹39,676 | **−₹1,048 to −₹1,944** | — | — | −₹463 to −₹1,540 | — | — |
| CE + PE 200 | +₹42,146 | +₹1,422 | −₹3,423 | 5/35 | +₹21,520 | +₹271 | −₹3,423 |

CE 200 is each account's best in both periods: High +₹253, Medium +₹774, Income +₹1,022, Low +₹528 over 1 Oct – 4 Nov.

**Day by day, 20 Oct – 4 Nov, CE 200 against current:**

| Days | CE 200 against current |
|---|---|
| Better | 5 days |
| Worse | 8 days |
| Same | 3 days |
| 21 Oct | +₹597 |
| 30 Oct (950-point hour) | +₹584 |
| 4 Nov (1,084-point hour) | +₹385 |
| The other 13 days | −₹311 |
| Worst single miss (2 Nov) | −₹227 |

It is insurance against a rally running over the calls. Every CE level 150–600 beats the current guard in both periods; 200
is the top. **Not applied** — waiting on the owner.

## 7. Methods: Include and Exclude

Owner: "methods exclude / include add panra maari ethachu iruka ... 1 Oct to now paaru, iniku V shape". Every signal 1 Oct –
4 Nov at the live rule (0.12, $11), 07:00–17:00, each account's min SL, one contract, no cap; each method × timeframe
judged on the span, its halves (1–17 Oct / 18 Oct – 4 Nov), without 4 Nov, and week by week (weeks 40–45). The strategies
trade the list the 14-day pick sets (win 70%, "only if better") plus Include, less Exclude.

- 338 of the 356 traded cells made money (+₹77,334 together); the 14 losing ones with 20+ trades lost −₹364 together.
- No excluded method made money in both halves: nothing to take out of Exclude.
- **Added to Exclude** (lost even without 4 Nov):

  | TF | Method | Net | w/o 4 Nov |
  |---|---|---|---|
  | 3m | #127 trend-efficiency break | −₹50 | −₹50 |
  | 3m | #6 BOS | −₹11 | −₹11 |
  | 15m | #4 FVG retest | −₹35 | ₹0 |
  | all time | #30 session H/L sweep | −₹48 | −₹54 |

- **Added to Include** (up every week they traded, both halves, without 4 Nov; traded only because the pick chose them, so
  pinned against being dropped):

  | TF | Methods added |
  |---|---|
  | 30m | ib-fail (+₹441), z-reversion (+₹349), pd-rejection (+₹337), nr7 (+₹312), trap (+₹307), em-edge (+₹253), equal-sweep (+₹229) |
  | 1h | z-reversion, trap, pd-rejection, options-flow |
  | 2h | stacked-continuation, options-flow |
  | 4h | stacked-continuation |
  | 15m | em-edge (+₹336) |
  | 5m | equal-sweep (+₹420) |
  | all time | ib-fail (+₹655), equal-sweep (+₹387), trendline-retest (+₹183) |

  About twenty more cells have the same profile and were left for the next look.
- **Watch, not excluded** — down over the span, up without 4 Nov:

  | TF | Method | Net | w/o 4 Nov |
  |---|---|---|---|
  | 3m | pullback | −₹75 | +₹96 |
  | 2h | naked-poc | −₹65 | +₹43 |
  | 3m | trade-velocity (in Include) | −₹22 | +₹129 |

- The new lists reach the traded `methods` at the next pick ("Pick now", or the 14-day run).

The Option history page's grid still replays at the old built-in rule (0.10 / $13) and may count perp exits: its colours
are not these.

## 8. Session loss limit, first day

Built and deployed on 4 Nov:
- per account, sessions of the IST day, ₹ or % of "At most open" × margin;
- at the limit, held 15 s, the account is squared off and takes no entry until midnight.

The owner switched it on at 17:23–17:24, 07:00–17:29 at 15%, on all four accounts. Each had already lost more since 07:00,
so each hit 15 s after its save:

| Account | Lost since 07:00 | Limit |
|---|---|---|
| High | ₹1,138 | ₹802 |
| Medium | ₹1,325 | ₹752 |
| Low | ₹1,570 | ₹777 |
| Income | ₹1,234 | ₹802 |

Nothing was open, so nothing was closed. The setting stays on: one day-long session, about ₹750–800 a day per account at
cap 160, rising with the cap. A limit switched on mid-session counts from the session's start.

## 9. Option SL 250% / 300% / 350% / 400% (6 Nov)

Owner: "SL % 250 vs 300 vs 350 vs 400 compare all account settings in Oct to now and 20 Oct to now". Every real order
1 Oct – 5 Nov on all four accounts (14,744; each account's own settings as they were) replayed on its real option quotes
with only the option SL changed; the rest as live (perp SL/TGT skipped, 90% target). Calibrated: at 250% the replay gives
+₹1,053 against the real +₹868 (1 Oct) and +₹7,969 against +₹8,465 (20 Oct). Script `slpct-dump.mts`, report
`slpct-report.py` (session scratchpad).

| Net, all 4 accounts | 250% (live) | 300% | 350% | 400% |
|---|--:|--:|--:|--:|
| 1 Oct – 5 Nov | **+₹1,053** | −₹4,982 | −₹10,167 | −₹10,694 |
| 20 Oct – 5 Nov | +₹7,969 | +₹6,590 | **+₹8,039** | +₹7,530 |
| Worst day (20 Oct) | **−₹7,288** | −₹9,063 | −₹10,316 | −₹11,925 |
| Win % (20 Oct) | 85.7 | 86.8 | 88.8 | 89.5 |
| 13 Oct against 250% | – | −₹5,288 | −₹12,586 | −₹14,320 |
| 4 Nov against 250% | – | −₹1,775 | −₹3,028 | −₹4,638 |

| Net 20 Oct – 5 Nov | 250% | 300% | 350% | 400% |
|---|--:|--:|--:|--:|
| High | +₹3,746 | +₹3,431 | +₹4,042 | +₹4,026 |
| Medium | +₹2,767 | +₹2,459 | +₹2,969 | +₹2,902 |
| Low | +₹1,284 | +₹923 | +₹1,451 | +₹1,301 |
| Income | **+₹172** | −₹223 | −₹423 | −₹698 |

Wider wins on quiet days (30 Oct +₹1.4–2.1k, 2 Nov, 28 Oct, 15 Oct) and gives it all back and more on a spike day: 13 Oct
alone is −₹5.3k to −₹14.3k, 4 Nov −₹1.8k to −₹4.6k. Win % rises with the stop, the loss per stop grows faster. 350% is
level with 250% since 20 Oct (+₹70) only by excluding 13 Oct, with a worst day 42% deeper. **Keep 250%**, as §1 of the
1 Nov write-up found. The SL change that held up there is by side (CE 100–150%, PE 400%), which needs code.
Not modelled: a wider stop holds a position longer (fewer new entries under the cap) and makes fewer SL re-entries.

## Open for the 9–10 Nov review

- Caps 250 / 200 as the §1 minimums assume.
- Momentum guard CE 200 on all four.
- $11 against $12.
- The twenty further Include candidates and the watched methods.
- Updating the replay's `SIGNAL_STRIKE` to the live rule (0.12 / $11), so the Option history page matches the desk.
