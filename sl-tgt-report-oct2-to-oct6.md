# SL / TGT trade report: 02 Oct to 06 Oct 2026

**Period:** 02 Oct 19:58 → 06 Oct 16:32 IST (2026) · **Source:** `tgt.txt` (311 wins) and `sl.txt` (156 losses) · **467 closed trades**, all option SELL trades opened by a signal method.

> **Read this first**
>
> - Every ₹ figure is the trade's own net result as printed in your list (after charges).
> - **Profit factor (PF)** = money won ÷ money lost. Above 1.00 makes money; below 1.00 loses money.
> - The time on each trade is the time it **closed**. The files do not hold the entry time, so the time tables show when trades ended, not when they were opened.
> - This is about four trading days in one market (83,894 – 86,865 on the BTC perp). A method with fewer than 10 trades is marked *Too few trades*: do not judge it yet.

## 1. Short answer

- **Overall the desk made +₹997.41** ($11.74): 311 won, 156 lost, 66.6% win rate, profit factor 1.66.
- **Best time frames: 4h, 30m and 1h.** Together they made +₹960.81 from 233 trades. **15m is the busiest and the weakest:** 178 trades for only +₹35.71. 5m is flat.
- **Best method with enough trades to judge, by a clear margin: #63 Initial balance failed break** — 48 trades, 92% won, +₹228.86. Next: #19 VWAP reclaim / loss (+₹119.97), #39 NR7 / inside-bar break (+₹79.37), #15 Opening-range breakout (Asia · London · New York) (+₹55.32).
- **Losing methods (10+ trades each):** #71 Call / put OI divergence (−₹78.61), #29 OI-confirmed breakout (−₹49.44), #36 Trendline break & retest (−₹34.43), #52 Order-book imbalance breakout (−₹30.32), #55 Pulled wall (spoof / pull) (−₹27.75), #1 Breakout (−₹23.09), #9 Pullback (−₹12.95).
- **TGT-wise the desk is fine; SL-wise is where the money goes.** Trades that ended at a target made +₹2,317.98. Trades that ended at the perp SL cost ₹1,332.47 net, and their losses are 99% of all the money lost.
- **Four bad moments cost ₹647.53** (43% of all losses): many methods were holding the same put options and one fall in price stopped them all in the same minute (section 6.3).
- **Time of day:** the second half of the trading day (05:30 → 17:29) made +₹1,305.74 at 78% won; the first half (17:35 → 05:29) lost ₹308.33 at 51% won. These are closing times, so part of this is simply that winning trades take hours to reach their target (section 6.2).

## 2. Overall numbers

| Measure | Value |
|:--|--:|
| Closed trades | 467 |
| Won / lost | 311 / 156 |
| Win rate | 66.6% |
| Money won | +₹2,512.82 |
| Money lost | −₹1,515.41 |
| **Net** | **+₹997.41** ($11.74) |
| Profit factor | 1.66 |
| Average win | +₹8.08 |
| Average loss | −₹9.71 |
| Biggest win | +₹28.69 |
| Biggest loss | −₹46.17 |

The average loss (₹9.71) is bigger than the average win (₹8.08). The desk makes money because it wins two trades out of three, so the win rate has to stay above about 55% to stay in profit.

## 3. How the trades ended (TGT-wise and SL-wise)

| Ended by | Trades | Won | Lost | Win % | Net ₹ | Avg win | Avg loss | What it means |
|:--|--:|--:|--:|--:|--:|--:|--:|:--|
| Option target hit | 145 | 145 | 0 | 100% | +₹1,663.20 | ₹11.47 | – | the option was bought back at about 10% of the price it was sold at |
| Perp TGT hit | 145 | 131 | 14 | 90% | +₹654.78 | ₹5.13 | ₹1.24 | the BTC perp reached the signal's target |
| Perp SL hit | 171 | 33 | 138 | 19% | −₹1,332.47 | ₹4.94 | ₹10.84 | the BTC perp reached the signal's stop |
| Closed manually | 2 | 2 | 0 | 100% | +₹14.48 | ₹7.24 | – | square off |
| No exit recorded | 4 | 0 | 4 | 0% | −₹2.58 | – | ₹0.65 | no buy-back price in the list; fees only |

- **Option target** is the best ending: 145 trades, none lost, ₹11.47 each on average.
- **Perp TGT** wins often but pays less than half as much (₹5.13 on average): the option is bought back before it has decayed. 14 of them still lost a little (average ₹1.24): the perp reached its target but the option cost more to buy back than it was sold for.
- **Perp SL** is the costly ending: 138 losses, ₹10.84 each. 33 SL endings were still wins, because the option had already lost value by the time the stop came.

**TGT-wise: methods that end at a target most often** (10+ trades)

| Method | Trades | Ended at TGT | Ended at SL | Net ₹ |
|:--|--:|--:|--:|--:|
| #63 Initial balance failed break | 48 | 40 (83%) | 8 (17%) | +₹228.86 |
| #8 Momentum | 10 | 8 (80%) | 2 (20%) | +₹4.19 |
| #9 Pullback | 14 | 11 (79%) | 3 (21%) | −₹12.95 |
| #54 Liquidity replenishment | 23 | 17 (74%) | 6 (26%) | +₹47.15 |
| #19 VWAP reclaim / loss | 31 | 22 (71%) | 8 (26%) | +₹119.97 |
| #59 Footprint stacked imbalance – continuation | 11 | 7 (64%) | 3 (27%) | +₹42.14 |

**SL-wise: methods that end at the stop most often** (10+ trades)

| Method | Trades | Ended at TGT | Ended at SL | Net ₹ |
|:--|--:|--:|--:|--:|
| #36 Trendline break & retest | 11 | 3 (27%) | 8 (73%) | −₹34.43 |
| #55 Pulled wall (spoof / pull) | 17 | 5 (29%) | 12 (71%) | −₹27.75 |
| #71 Call / put OI divergence | 19 | 7 (37%) | 12 (63%) | −₹78.61 |
| #29 OI-confirmed breakout | 18 | 8 (44%) | 10 (56%) | −₹49.44 |
| #47 IV expansion breakout | 16 | 8 (50%) | 8 (50%) | +₹43.79 |
| #52 Order-book imbalance breakout | 22 | 12 (55%) | 10 (45%) | −₹30.32 |

## 4. Time frames

| Time frame | Trades | W–L | Win % | Net ₹ | Avg win | Avg loss | PF | Ended at TGT | Ended at SL |
|:--|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 5m | 50 | 25–25 | 50% | +₹16.61 | ₹5.98 | ₹5.31 | 1.13 | 50% | 50% |
| 15m | 178 | 104–74 | 58% | +₹35.71 | ₹6.55 | ₹8.72 | 1.06 | 54% | 44% |
| 30m | 116 | 87–29 | 75% | +₹402.92 | ₹8.97 | ₹13.02 | 2.07 | 65% | 34% |
| 1h | 88 | 67–21 | 76% | +₹272.43 | ₹8.24 | ₹13.31 | 1.97 | 74% | 25% |
| 4h | 29 | 26–3 | 90% | +₹285.46 | ₹12.73 | ₹15.21 | 7.26 | 90% | 10% |
| 5m + TF chain *(shown as "All time frame")* | 6 | 2–4 | 33% | −₹15.72 | ₹9.51 | ₹8.69 | 0.55 | 33% | 67% |

- **4h** has the best quality (PF 7.26, 90% won) but only 29 trades.
- **30m and 1h** carry the profit: three wins in four, PF about 2.
- **15m** is 38% of all trades and returns almost nothing (PF 1.06). It is not that every method is bad on 15m: some methods win there and some lose (section 5.3).
- **5m** wins only half the time (PF 1.13). **5m + TF chain** has 6 trades: too few to judge.

## 5. Methods

How the verdict is given, for methods with 10 or more trades: **Strong** = PF 1.50 or more · Thin edge = PF 1.00 to 1.49 · **Losing** = PF under 1.00.

### 5.1 Methods with 10 or more trades (17 methods, 337 trades)

| Method | Trades | W–L | Win % | Net ₹ | Avg win | Avg loss | PF | TGT ends | SL ends | Verdict |
|:--|--:|--:|--:|--:|--:|--:|--:|--:|--:|:--|
| #63 Initial balance failed break | 48 | 44–4 | 92% | +₹228.86 | ₹6.41 | ₹13.34 | 5.29 | 40 | 8 | **Strong** |
| #19 VWAP reclaim / loss | 31 | 24–7 | 77% | +₹119.97 | ₹7.30 | ₹7.87 | 3.18 | 22 | 8 | **Strong** |
| #39 NR7 / inside-bar break | 13 | 9–4 | 69% | +₹79.37 | ₹12.37 | ₹7.99 | 3.48 | 7 | 5 | **Strong** |
| #15 Opening-range breakout (Asia · London · New York) | 14 | 9–5 | 64% | +₹55.32 | ₹9.57 | ₹6.17 | 2.79 | 8 | 6 | **Strong** |
| #72 IV vs realised volatility | 25 | 16–9 | 64% | +₹54.18 | ₹8.60 | ₹9.27 | 1.65 | 14 | 11 | **Strong** |
| #54 Liquidity replenishment | 23 | 18–5 | 78% | +₹47.15 | ₹7.89 | ₹18.97 | 1.50 | 17 | 6 | **Strong** |
| #47 IV expansion breakout | 16 | 10–6 | 62% | +₹43.79 | ₹7.48 | ₹5.17 | 2.41 | 8 | 8 | **Strong** |
| #59 Footprint stacked imbalance – continuation | 11 | 8–3 | 73% | +₹42.14 | ₹7.34 | ₹5.54 | 3.54 | 7 | 3 | **Strong** |
| #37 Channel breakout | 20 | 11–9 | 55% | +₹16.38 | ₹5.67 | ₹5.11 | 1.36 | 11 | 9 | Thin edge |
| #8 Momentum | 10 | 7–3 | 70% | +₹4.19 | ₹7.23 | ₹15.47 | 1.09 | 8 | 2 | Thin edge |
| #9 Pullback | 14 | 11–3 | 79% | −₹12.95 | ₹5.39 | ₹24.07 | 0.82 | 11 | 3 | **Losing** |
| #1 Breakout | 25 | 15–10 | 60% | −₹23.09 | ₹6.35 | ₹11.83 | 0.80 | 14 | 11 | **Losing** |
| #55 Pulled wall (spoof / pull) | 17 | 6–11 | 35% | −₹27.75 | ₹12.62 | ₹9.41 | 0.73 | 5 | 12 | **Losing** |
| #52 Order-book imbalance breakout | 22 | 12–10 | 55% | −₹30.32 | ₹5.08 | ₹9.13 | 0.67 | 12 | 10 | **Losing** |
| #36 Trendline break & retest | 11 | 3–8 | 27% | −₹34.43 | ₹12.98 | ₹9.17 | 0.53 | 3 | 8 | **Losing** |
| #29 OI-confirmed breakout | 18 | 9–9 | 50% | −₹49.44 | ₹3.95 | ₹9.44 | 0.42 | 8 | 10 | **Losing** |
| #71 Call / put OI divergence | 19 | 8–11 | 42% | −₹78.61 | ₹7.51 | ₹12.61 | 0.43 | 7 | 12 | **Losing** |

What stands out:

- **#63 Initial balance failed break** made 23% of the whole net profit by itself, and it is in profit on each of 15m, 30m and 1h.
- **#9 Pullback** wins 79% of the time and still loses money: its average loss (₹24.07) is more than four times its average win (₹5.39). **#54 Liquidity replenishment** is in profit but has the same weakness (average loss ₹18.97): a few stops take back most of what it makes. A high win rate is not enough.
- **#71 Call / put OI divergence** and **#29 OI-confirmed breakout** are the two clear losers: more than half their trades end at the stop.
- **#55 Pulled wall** is two different stories: fine on 4h, 0 wins from 5 on 15m (section 5.3).

### 5.2 Methods with fewer than 10 trades (34 methods, 130 trades)

Shown for completeness. The sample is too small to call any of these good or bad.

| Method | Trades | W–L | Win % | Net ₹ | Avg win | Avg loss | PF | TGT ends | SL ends |
|:--|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| #31 Expected-move edge reaction | 8 | 8–0 | 100% | +₹108.98 | ₹13.62 | – | ∞ | 8 | 0 |
| #12 Options / derivatives | 8 | 7–1 | 88% | +₹82.88 | ₹13.88 | ₹14.26 | 6.81 | 7 | 1 |
| #53 Microprice / queue imbalance | 9 | 8–1 | 89% | +₹73.67 | ₹10.44 | ₹9.82 | 8.50 | 8 | 1 |
| #3 Liquidity sweep | 4 | 4–0 | 100% | +₹69.07 | ₹17.27 | – | ∞ | 4 | 0 |
| #14 Failed breakout / breakdown (trap) | 7 | 6–1 | 86% | +₹67.25 | ₹11.51 | ₹1.78 | 38.78 | 6 | 1 |
| #33 Z-score reversion | 3 | 3–0 | 100% | +₹50.05 | ₹16.68 | – | ∞ | 3 | 0 |
| #50 Gamma wall reaction | 7 | 6–1 | 86% | +₹38.91 | ₹6.56 | ₹0.46 | 85.59 | 4 | 2 |
| #26 Equal H/L sweep & reclaim | 6 | 5–1 | 83% | +₹27.83 | ₹14.80 | ₹46.17 | 1.60 | 5 | 1 |
| #62 Initial balance break | 3 | 2–1 | 67% | +₹26.73 | ₹16.16 | ₹5.60 | 5.77 | 2 | 1 |
| #38 Engulfing + structure | 7 | 6–1 | 86% | +₹24.65 | ₹5.98 | ₹11.21 | 3.20 | 6 | 1 |
| #79 Trend-efficiency break | 2 | 2–0 | 100% | +₹20.10 | ₹10.05 | – | ∞ | 1 | 0 |
| #35 Mid-range rejection | 5 | 4–1 | 80% | +₹18.85 | ₹5.72 | ₹4.05 | 5.65 | 4 | 1 |
| #61 Naked POC reaction | 1 | 1–0 | 100% | +₹17.87 | ₹17.87 | – | ∞ | 1 | 0 |
| #34 Multi-factor regime entry | 2 | 2–0 | 100% | +₹15.91 | ₹7.96 | – | ∞ | 2 | 0 |
| #18 Previous-day range expansion | 1 | 1–0 | 100% | +₹10.24 | ₹10.24 | – | ∞ | 1 | 0 |
| #73 Term-structure inversion | 1 | 1–0 | 100% | +₹9.59 | ₹9.59 | – | ∞ | 1 | 0 |
| #51 Expiry pin / max-pain magnet | 2 | 1–1 | 50% | +₹6.90 | ₹7.12 | ₹0.22 | 32.36 | 1 | 1 |
| #6 BOS | 4 | 3–1 | 75% | +₹6.82 | ₹3.02 | ₹2.23 | 4.06 | 3 | 1 |
| #16 Previous day H/L rejection | 4 | 1–3 | 25% | +₹5.23 | ₹7.87 | ₹0.88 | 2.98 | 1 | 3 |
| #5 Order-block retest | 6 | 2–4 | 33% | +₹4.90 | ₹8.62 | ₹3.08 | 1.40 | 2 | 4 |
| #17 Previous day H/L break & hold | 1 | 1–0 | 100% | +₹2.58 | ₹2.58 | – | ∞ | 1 | 0 |
| #41 Basis divergence (perp vs index) | 1 | 1–0 | 100% | +₹1.66 | ₹1.66 | – | ∞ | 1 | 0 |
| #78 Range-efficiency entry | 1 | 1–0 | 100% | +₹1.41 | ₹1.41 | – | ∞ | 1 | 0 |
| #76 Volume z-score spike | 5 | 2–3 | 40% | +₹1.06 | ₹14.92 | ₹9.59 | 1.04 | 1 | 3 |
| #75 Volatility z-score spike | 1 | 0–1 | 0% | −₹2.71 | – | ₹2.71 | 0.00 | 0 | 1 |
| #20 Anchored VWAP (week) | 3 | 1–2 | 33% | −₹3.86 | ₹16.88 | ₹10.37 | 0.81 | 1 | 2 |
| #32 Volatility regime transition | 1 | 0–1 | 0% | −₹6.49 | – | ₹6.49 | 0.00 | 0 | 1 |
| #13 Compression break | 4 | 3–1 | 75% | −₹7.72 | ₹9.30 | ₹35.62 | 0.78 | 3 | 1 |
| #10 VWAP / mean reversion | 3 | 1–2 | 33% | −₹8.59 | ₹10.91 | ₹9.75 | 0.56 | 1 | 2 |
| #2 Breakout + retest | 4 | 1–3 | 25% | −₹9.91 | ₹4.94 | ₹4.95 | 0.33 | 1 | 3 |
| #57 Trade velocity / aggression spike | 5 | 3–2 | 60% | −₹9.98 | ₹1.10 | ₹6.64 | 0.25 | 3 | 2 |
| #11 Order flow | 3 | 1–2 | 33% | −₹24.91 | ₹2.65 | ₹13.78 | 0.10 | 1 | 2 |
| #21 Value-area break | 4 | 2–2 | 50% | −₹26.46 | ₹2.23 | ₹15.46 | 0.14 | 2 | 2 |
| #40 Dislocation reversion | 4 | 1–3 | 25% | −₹29.86 | ₹2.37 | ₹10.74 | 0.07 | 2 | 2 |

Worth watching as they collect trades: **#31 Expected-move edge reaction** (8 from 8), **#12 Options / derivatives** (7 from 8), **#53 Microprice / queue imbalance** (8 from 9), **#14 Failed breakout / breakdown** (6 from 7), **#3 Liquidity sweep** (4 from 4).

### 5.3 Which method on which time frame

Pairs with at least 4 trades. Small samples: read these as leads to watch, not as proof.

**Best 12 pairs**

| Method | TF | Trades | W–L | Win % | Net ₹ | PF |
|:--|:--|--:|--:|--:|--:|--:|
| #63 Initial balance failed break | 15m | 20 | 18–2 | 90% | +₹94.87 | 40.53 |
| #19 VWAP reclaim / loss | 30m | 15 | 13–2 | 87% | +₹86.37 | 6.87 |
| #31 Expected-move edge reaction | 5m | 4 | 4–0 | 100% | +₹71.03 | ∞ |
| #63 Initial balance failed break | 30m | 16 | 14–2 | 88% | +₹70.28 | 2.38 |
| #26 Equal H/L sweep & reclaim | 30m | 4 | 4–0 | 100% | +₹63.32 | ∞ |
| #63 Initial balance failed break | 1h | 11 | 11–0 | 100% | +₹62.72 | ∞ |
| #53 Microprice / queue imbalance | 4h | 5 | 5–0 | 100% | +₹62.40 | ∞ |
| #39 NR7 / inside-bar break | 30m | 8 | 6–2 | 75% | +₹59.79 | 7.32 |
| #14 Failed breakout / breakdown (trap) | 1h | 6 | 5–1 | 83% | +₹56.87 | 32.95 |
| #54 Liquidity replenishment | 4h | 5 | 5–0 | 100% | +₹56.86 | ∞ |
| #72 IV vs realised volatility | 1h | 4 | 4–0 | 100% | +₹43.49 | ∞ |
| #31 Expected-move edge reaction | 1h | 4 | 4–0 | 100% | +₹37.95 | ∞ |

**Worst 12 pairs**

| Method | TF | Trades | W–L | Win % | Net ₹ | PF |
|:--|:--|--:|--:|--:|--:|--:|
| #71 Call / put OI divergence | 15m | 14 | 6–8 | 43% | −₹57.95 | 0.42 |
| #36 Trendline break & retest | 5m | 7 | 0–7 | 0% | −₹53.43 | 0.00 |
| #9 Pullback | 30m | 7 | 5–2 | 71% | −₹41.16 | 0.31 |
| #29 OI-confirmed breakout | 15m | 14 | 7–7 | 50% | −₹40.92 | 0.38 |
| #54 Liquidity replenishment | 1h | 14 | 9–5 | 64% | −₹35.86 | 0.62 |
| #55 Pulled wall (spoof / pull) | 15m | 5 | 0–5 | 0% | −₹35.11 | 0.00 |
| #52 Order-book imbalance breakout | 30m | 5 | 3–2 | 60% | −₹27.95 | 0.29 |
| #71 Call / put OI divergence | 30m | 5 | 2–3 | 40% | −₹20.66 | 0.48 |
| #52 Order-book imbalance breakout | 15m | 13 | 6–7 | 46% | −₹20.37 | 0.60 |
| #72 IV vs realised volatility | 30m | 5 | 2–3 | 40% | −₹19.10 | 0.50 |
| #1 Breakout | 15m | 18 | 11–7 | 61% | −₹14.30 | 0.85 |
| #2 Breakout + retest | 15m | 4 | 1–3 | 25% | −₹9.91 | 0.33 |

## 6. Time report: trading day 17:35 → 17:29

A trading day here runs from 17:35 (after the 17:30 settlement) to 17:29 the next day. Times are closing times, IST.

### 6.1 Day by day

| Trading day | Trades | W–L | Win % | Net ₹ | Avg win | Avg loss | PF | TGT ends | SL ends | Note |
|:--|--:|--:|--:|--:|--:|--:|--:|--:|--:|:--|
| 02 Oct 17:35 → 03 Oct 17:29 | 114 | 91–23 | 80% | +₹494.68 | ₹7.08 | ₹6.51 | 4.30 | 84 | 26 | list starts 19:58 |
| 03 Oct 17:35 → 04 Oct 17:29 | 117 | 70–47 | 60% | −₹106.29 | ₹3.42 | ₹7.36 | 0.69 | 64 | 53 |  |
| 04 Oct 17:35 → 05 Oct 17:29 | 128 | 93–35 | 73% | +₹570.48 | ₹9.01 | ₹7.65 | 3.13 | 89 | 37 |  |
| 05 Oct 17:35 → 06 Oct 17:29 | 108 | 57–51 | 53% | +₹38.54 | ₹13.87 | ₹14.75 | 1.05 | 53 | 55 | list ends 16:32 |

Two good days (+₹494.68 and +₹570.48), one losing day (−₹106.29) and one flat day (+₹38.54). On the last day both wins and losses were much larger than on the days before (average win ₹13.87, average loss ₹14.75), and about half the trades ended at the stop.

### 6.2 Hour by hour inside the trading day

All four days added together, then each day's net for the same hour, so you can see whether an hour is steadily good or bad, or only looks so because of one day. `·` = no trade closed in that hour.

| Hour (IST) | Trades | W–L | Win % | Net ₹ | 02→03 Oct | 03→04 Oct | 04→05 Oct | 05→06 Oct |
|:--|--:|--:|--:|--:|--:|--:|--:|--:|
| 17:35 – 18:29 | 5 | 1–4 | 20% | −₹7.01 | · | −₹2.96 | −₹4.05 | · |
| 18:30 – 19:29 | 7 | 0–7 | 0% | −₹70.50 | · | −₹18.00 | · | −₹52.50 |
| 19:30 – 20:29 | 28 | 9–19 | 32% | **−₹290.38** | +₹19.59 | · | · | −₹309.97 |
| 20:30 – 21:29 | 7 | 2–5 | 29% | −₹1.19 | +₹3.61 | · | −₹4.80 | · |
| 21:30 – 22:29 | 16 | 11–5 | 69% | **+₹107.77** | +₹95.68 | · | −₹8.28 | +₹20.37 |
| 22:30 – 23:29 | 13 | 3–10 | 23% | −₹86.50 | −₹85.87 | −₹1.47 | · | +₹0.84 |
| 23:30 – 00:29 | 20 | 18–2 | 90% | +₹60.96 | +₹52.98 | · | · | +₹7.98 |
| 00:30 – 01:29 | 17 | 5–12 | 29% | −₹47.99 | +₹7.05 | −₹71.21 | −₹0.92 | +₹17.09 |
| 01:30 – 02:29 | 17 | 14–3 | 82% | +₹72.19 | +₹4.94 | −₹4.27 | +₹46.41 | +₹25.11 |
| 02:30 – 03:29 | 31 | 13–18 | 42% | **−₹135.91** | · | −₹194.97 | +₹27.92 | +₹31.14 |
| 03:30 – 04:29 | 17 | 11–6 | 65% | +₹17.65 | · | +₹3.32 | +₹14.33 | · |
| 04:30 – 05:29 | 15 | 11–4 | 73% | +₹72.58 | +₹38.25 | +₹2.37 | +₹10.86 | +₹21.10 |
| 05:30 – 06:29 | 10 | 3–7 | 30% | +₹0.77 | −₹7.33 | −₹29.71 | −₹4.46 | +₹42.27 |
| 06:30 – 07:29 | 15 | 2–13 | 13% | **−₹95.16** | · | · | −₹50.35 | −₹44.81 |
| 07:30 – 08:29 | 17 | 11–6 | 65% | +₹47.03 | +₹7.40 | +₹49.98 | +₹23.10 | −₹33.45 |
| 08:30 – 09:29 | 22 | 19–3 | 86% | **+₹171.18** | +₹9.77 | +₹7.23 | +₹28.78 | +₹125.40 |
| 09:30 – 10:29 | 18 | 16–2 | 89% | **+₹100.95** | +₹15.15 | −₹1.31 | +₹87.11 | · |
| 10:30 – 11:29 | 9 | 7–2 | 78% | +₹2.75 | · | +₹15.20 | −₹9.00 | −₹3.45 |
| 11:30 – 12:29 | 44 | 33–11 | 75% | **+₹238.75** | +₹40.96 | +₹53.29 | −₹44.61 | +₹189.11 |
| 12:30 – 13:29 | 29 | 21–8 | 72% | **+₹175.59** | +₹116.78 | −₹4.43 | +₹78.89 | −₹15.65 |
| 13:30 – 14:29 | 35 | 33–2 | 94% | **+₹237.34** | +₹92.74 | +₹24.60 | +₹196.95 | −₹76.95 |
| 14:30 – 15:29 | 30 | 26–4 | 87% | **+₹250.41** | +₹46.41 | +₹16.97 | +₹131.82 | +₹55.21 |
| 15:30 – 16:29 | 35 | 32–3 | 91% | **+₹98.32** | +₹10.17 | +₹49.08 | +₹25.08 | +₹13.99 |
| 16:30 – 17:29 | 10 | 10–0 | 100% | +₹77.81 | +₹26.40 | · | +₹25.70 | +₹25.71 |

- **17:35 → 20:29 (first three hours after settlement):** 40 trades, only 10 won, −₹367.89. Most of that is one event (05 Oct, 20:00–20:04, −₹301.89). Without it the block is 27 trades, 10 won, −₹66.00: weak, but a small sample.
- **08:30 → 17:29 (last nine hours before settlement):** the best part of the day and in profit on all four days (+₹358.38, +₹160.63, +₹520.72, +₹313.37). Two reasons, and the files cannot separate them: a sold option loses value fastest in its last hours, and a trade opened earlier that reaches its target usually reaches it here, so its win is counted in this block.
- **02:30 → 03:29** and **22:30 → 23:29** look bad in total but are bad on one day only: do not read a pattern into them yet. **06:30 → 07:29** lost on both days it had trades (2 wins from 15): one to watch.

**The same day in six blocks**

| Block (IST) | Trades | W–L | Win % | Net ₹ | PF | Ended at SL |
|:--|--:|--:|--:|--:|--:|--:|
| 17:35 – 20:29 | 40 | 10–30 | 25% | −₹367.89 | 0.11 | 80% |
| 20:30 – 00:29 | 56 | 34–22 | 61% | +₹81.04 | 1.55 | 34% |
| 00:30 – 05:29 | 97 | 54–43 | 56% | −₹21.48 | 0.94 | 44% |
| 05:30 – 08:29 | 42 | 16–26 | 38% | −₹47.36 | 0.79 | 57% |
| 08:30 – 12:29 | 93 | 75–18 | 81% | +₹513.63 | 3.92 | 38% |
| 12:30 – 17:29 | 139 | 122–17 | 88% | +₹839.47 | 5.46 | 13% |

### 6.3 The four bad moments

Each row is one fall in price that stopped many trades inside a few minutes.

| When | Losses | Money lost | Different methods | Contracts | Direction |
|:--|--:|--:|--:|:--|:--|
| 02 Oct 22:44–22:46 | 9 | −₹88.86 | 4 | 84,200 PE ×5, 84,400 PE ×2, 83,800 PE ×1, 86,000 CE ×1 | 8 of 9 BUY signals (sold puts) |
| 04 Oct 01:03–01:03 | 5 | −₹52.79 | 3 | 84,400 PE ×4, 84,200 PE ×1 | 5 of 5 BUY signals (sold puts) |
| 04 Oct 02:35–02:38 | 17 | −₹203.99 | 11 | 83,800 PE ×9, 84,000 PE ×4, 84,200 PE ×4 | 17 of 17 BUY signals (sold puts) |
| 05 Oct 20:00–20:04 | 13 | −₹301.89 | 11 | 84,400 PE ×6, 84,200 PE ×5, 84,000 PE ×2 | 13 of 13 BUY signals (sold puts) |
| **Total** | **44** | **−₹647.53** |  |  |  |

These 44 trades are 28% of the losing trades and 43% of the money lost. In the worst one, 11 different methods were short the same three put strikes. The methods agree with each other more than their names suggest, so in a fast move they behave like one big position, not many small ones.

## 7. Direction and option price

| Direction | Trades | W–L | Win % | Net ₹ | Avg win | Avg loss | PF |
|:--|--:|--:|--:|--:|--:|--:|--:|
| SELL signal → sold a call (CE) | 208 | 141–67 | 68% | +₹826.78 | ₹10.59 | ₹9.95 | 2.24 |
| BUY signal → sold a put (PE) | 259 | 170–89 | 66% | +₹170.63 | ₹6.00 | ₹9.54 | 1.20 |

The win rate is the same on both sides, but sold calls paid ₹10.59 per win against ₹6.00 for sold puts. The four bad moments in 6.3 were almost entirely on the put side (price falling).

**By the price the option was sold at**

| Sold at | Trades | W–L | Win % | Net ₹ | Avg win | Avg loss | PF | Worst trade |
|:--|--:|--:|--:|--:|--:|--:|--:|--:|
| under 15 | 76 | 63–13 | 83% | +₹77.42 | ₹2.25 | ₹4.95 | 2.20 | −₹20.74 |
| 15 – 29.9 | 23 | 16–7 | 70% | +₹16.66 | ₹4.48 | ₹7.85 | 1.30 | −₹17.51 |
| 30 – 39.9 | 89 | 52–37 | 58% | +₹158.50 | ₹9.51 | ₹9.08 | 1.47 | −₹46.17 |
| 40 – 49.9 | 228 | 149–79 | 65% | +₹506.62 | ₹9.36 | ₹11.24 | 1.57 | −₹40.26 |
| 50 and over | 51 | 31–20 | 61% | +₹238.21 | ₹13.23 | ₹8.60 | 2.39 | −₹24.84 |

Cheap options (sold under 15) win most often (83%) but earn little (₹2.25 a win) and can lose many times that: one sold at 6.00 was bought back at 39.00 for −₹20.74. Most of the profit comes from options sold at 40 and over.

## 8. What I would look at next

Ideas from the numbers above. None of them is applied: the desk's trading logic is unchanged.

1. **Too many methods on the same side at once.** This is the biggest single cost (section 6.3). A limit on how many open trades may sit on one side, or on one strike, would have cut the four bad moments most.
2. **15m time frame.** It has the most trades and the least return. The losing pairs are mostly on 15m: #71, #29, #52, #55 and #1 (section 5.3). #63, #72 and #47 do well on 15m.
3. **#36 Trendline break & retest on 5m:** 0 wins from 7. **#55 Pulled wall on 15m:** 0 wins from 5. Small samples, but nothing in their favour so far.
4. **#9 Pullback and #54 Liquidity replenishment:** good win rate, large losses. The stop distance is the thing to study, not the entry.
5. **The first three hours after settlement (17:35 → 20:29).** A loss overall, but most of it is one event. Worth another week of data before deciding.
6. **Keep collecting before judging the small ones.** 34 of the 51 methods have fewer than 10 trades.

---

*Made from `tgt.txt` and `sl.txt` on 06 Oct 2026. 467 trades; 4 losses in `sl.txt` have no buy-back price and are counted with their printed result (fees only).*
