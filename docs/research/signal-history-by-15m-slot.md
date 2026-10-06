# Signal history by 15-minute slot — target hits, stop hits and win rate, by method

What happened to every TRADE signal in the desk's signal history, grouped by the 15-minute slot it appeared in (the session, 5:35 PM to 5:29 PM IST) and by method. **19,060 closed trades** from **5.7 days of history, across 7 calendar dates**: 30 Sep 2026, 6:59 PM to 6 Oct 2026, 11:15 AM.

> **Read this first.** The history holds under six days. That is enough to see broad shapes — which hours and which methods did better this week — and nowhere near enough to rely on a single slot or a single method-and-slot pair. Many methods fire on the same price move, so the trades in a slot are not independent of each other either. Treat every number here as "what happened in these few days", not as what to expect.

## What the columns mean

| Column | Meaning |
|---|---|
| **Time (IST)** | The 15-minute slot the signal first appeared in. |
| **Signals** | TRADE signals that appeared in the slot. |
| **Closed** | Those that filled and finished: at the target, at the stop, or on time. Win rate is out of these. |
| **Target hit** | Closed at TGT1. A win. |
| **SL hit** | Closed at the stop. A loss. |
| **Timed out** | Reached neither and was closed on time; a win if it closed above its fill, else a loss. |
| **Win rate** | Closed in profit ÷ closed. The same rule as the Methods screen. |
| **Net pts** | BTC points won minus points lost, fill to exit, before fees. |
| **Days** | How many different calendar dates the slot had a closed trade. |

These are the desk's **paper** results on the BTC perpetual: each signal filled at its entry zone and exited at its TGT1, its stop or its time-out. They are not option P&L and not your account's trades.

## The short version

- **Overall:** of 19,060 closed trades, 38.7% hit the target, 57.6% hit the stop and 3.8% timed out. Win rate 41.0%, net +57,060 points.
- **1,768 signals never filled** and 220 were still open when this was written; neither is in the win rate.
- **Best hour by win rate:** 8:35 AM – 9:35 AM at 57.4% (751 trades, net +67,318 pts). **Worst:** 5:35 AM – 6:35 AM at 25.1% (801 trades, net −52,355 pts).
- **Most points won by a method:** #50 Gamma wall reaction, net +26,288 pts over 996 trades (43.5% win rate). **Most lost:** #14 Failed breakout / breakdown (trap), net −10,024 pts over 383 trades (51.4%).
- **9 of the 81 methods closed no trade** in these days.
- **A win rate under 50% can still make points**, and one over 50% can lose them: targets and stops are different sizes. Read win rate and net points together.

## Hour by hour

Each row is four 15-minute slots. The bar is the win rate.

| Hour (IST) | Closed | Target hit | SL hit | Timed out | Win rate | Net pts | Win rate bar |
|---|--:|--:|--:|--:|--:|--:|---|
| 5:35 PM – 6:35 PM | 980 | 314 (32%) | 613 (63%) | 53 (5%) | 35.0% | −49,855 | ███████ |
| 6:35 PM – 7:35 PM | 954 | 304 (32%) | 639 (67%) | 11 (1%) | 32.4% | −64,392 | ██████ |
| 7:35 PM – 8:35 PM | 1,015 | 440 (43%) | 516 (51%) | 59 (6%) | 48.0% | +113,523 | ██████████ |
| 8:35 PM – 9:35 PM | 797 | 246 (31%) | 514 (64%) | 37 (5%) | 32.6% | −13,115 | ███████ |
| 9:35 PM – 10:35 PM | 808 | 365 (45%) | 428 (53%) | 15 (2%) | 46.9% | +9,215 | █████████ |
| 10:35 PM – 11:35 PM | 1,070 | 418 (39%) | 598 (56%) | 54 (5%) | 40.3% | +49,550 | ████████ |
| 11:35 PM – 12:35 AM | 774 | 332 (43%) | 370 (48%) | 72 (9%) | 47.2% | −2,636 | █████████ |
| 12:35 AM – 1:35 AM | 763 | 346 (45%) | 392 (51%) | 25 (3%) | 47.6% | +2,721 | ██████████ |
| 1:35 AM – 2:35 AM | 740 | 331 (45%) | 375 (51%) | 34 (5%) | 48.5% | +33,077 | ██████████ |
| 2:35 AM – 3:35 AM | 768 | 253 (33%) | 460 (60%) | 55 (7%) | 37.9% | −6,469 | ████████ |
| 3:35 AM – 4:35 AM | 794 | 246 (31%) | 523 (66%) | 25 (3%) | 33.6% | −3,276 | ███████ |
| 4:35 AM – 5:35 AM | 803 | 256 (32%) | 539 (67%) | 8 (1%) | 32.9% | −31,845 | ███████ |
| 5:35 AM – 6:35 AM | 801 | 191 (24%) | 584 (73%) | 26 (3%) | 25.1% | −52,355 | █████ |
| 6:35 AM – 7:35 AM | 903 | 448 (50%) | 415 (46%) | 40 (4%) | 53.3% | +34,004 | ███████████ |
| 7:35 AM – 8:35 AM | 784 | 309 (39%) | 463 (59%) | 12 (2%) | 40.6% | +29,230 | ████████ |
| 8:35 AM – 9:35 AM | 751 | 427 (57%) | 320 (43%) | 4 (1%) | 57.4% | +67,318 | ███████████ |
| 9:35 AM – 10:35 AM | 675 | 208 (31%) | 409 (61%) | 58 (9%) | 36.4% | −58,651 | ███████ |
| 10:35 AM – 11:35 AM | 676 | 354 (52%) | 311 (46%) | 11 (2%) | 52.7% | +8,918 | ███████████ |
| 11:35 AM – 12:35 PM | 630 | 189 (30%) | 407 (65%) | 34 (5%) | 31.4% | −31,175 | ██████ |
| 12:35 PM – 1:35 PM | 659 | 284 (43%) | 360 (55%) | 15 (2%) | 45.2% | +24,640 | █████████ |
| 1:35 PM – 2:35 PM | 631 | 232 (37%) | 371 (59%) | 28 (4%) | 40.4% | +1,240 | ████████ |
| 2:35 PM – 3:35 PM | 836 | 369 (44%) | 439 (53%) | 28 (3%) | 46.5% | +19,581 | █████████ |
| 3:35 PM – 4:35 PM | 880 | 285 (32%) | 585 (66%) | 10 (1%) | 33.1% | −12,162 | ███████ |
| 4:35 PM – 5:30 PM | 568 | 225 (40%) | 342 (60%) | 1 (0%) | 39.6% | −10,027 | ████████ |

## Every 15-minute slot

| # | Time (IST) | Signals | Closed | Target hit | SL hit | Timed out | Win rate | Net pts | Days |
|--:|---|--:|--:|--:|--:|--:|--:|--:|--:|
| 1 | 5:35 PM – 5:50 PM | 275 | 231 | 87 (38%) | 126 (55%) | 18 (8%) | 45.5% | −1,571 | 5 |
| 2 | 5:50 PM – 6:05 PM | 328 | 294 | 89 (30%) | 172 (59%) | 33 (11%) | 33.7% | −9,968 | 5 |
| 3 | 6:05 PM – 6:20 PM | 252 | 238 | 81 (34%) | 157 (66%) | 0 (0%) | 34.0% | −9,463 | 5 |
| 4 | 6:20 PM – 6:35 PM | 233 | 217 | 57 (26%) | 158 (73%) | 2 (1%) | 26.7% | −28,853 | 5 |
| 5 | 6:35 PM – 6:50 PM | 246 | 234 | 58 (25%) | 176 (75%) | 0 (0%) | 24.8% | −25,776 | 5 |
| 6 | 6:50 PM – 7:05 PM | 217 | 192 | 66 (34%) | 126 (66%) | 0 (0%) | 34.4% | −10,286 | 6 |
| 7 | 7:05 PM – 7:20 PM | 261 | 251 | 80 (32%) | 161 (64%) | 10 (4%) | 33.9% | −10,335 | 5 |
| 8 | 7:20 PM – 7:35 PM | 291 | 277 | 100 (36%) | 176 (64%) | 1 (0%) | 36.1% | −17,996 | 6 |
| 9 | 7:35 PM – 7:50 PM | 268 | 246 | 90 (37%) | 153 (62%) | 3 (1%) | 37.4% | +3,951 | 5 |
| 10 | 7:50 PM – 8:05 PM | 281 | 257 | 120 (47%) | 134 (52%) | 3 (1%) | 47.9% | +51,879 | 6 |
| 11 | 8:05 PM – 8:20 PM | 270 | 251 | 78 (31%) | 154 (61%) | 19 (8%) | 34.3% | +13,982 | 6 |
| 12 | 8:20 PM – 8:35 PM | 297 | 261 | 152 (58%) | 75 (29%) | 34 (13%) | 71.3% | +43,710 | 5 |
| 13 | 8:35 PM – 8:50 PM | 242 | 228 | 60 (26%) | 160 (70%) | 8 (4%) | 29.8% | −11,823 | 5 |
| 14 | 8:50 PM – 9:05 PM | 193 | 177 | 46 (26%) | 106 (60%) | 25 (14%) | 27.7% | −4,185 | 6 |
| 15 | 9:05 PM – 9:20 PM | 174 | 154 | 53 (34%) | 101 (66%) | 0 (0%) | 34.4% | −9,660 | 6 |
| 16 | 9:20 PM – 9:35 PM | 265 | 238 | 87 (37%) | 147 (62%) | 4 (2%) | 37.8% | +12,553 | 5 |
| 17 | 9:35 PM – 9:50 PM | 207 | 192 | 69 (36%) | 123 (64%) | 0 (0%) | 35.9% | −2,229 | 6 |
| 18 | 9:50 PM – 10:05 PM | 191 | 179 | 77 (43%) | 101 (56%) | 1 (1%) | 43.6% | +3,567 | 6 |
| 19 | 10:05 PM – 10:20 PM | 261 | 243 | 118 (49%) | 117 (48%) | 8 (3%) | 51.9% | −3,842 | 6 |
| 20 | 10:20 PM – 10:35 PM | 201 | 194 | 101 (52%) | 87 (45%) | 6 (3%) | 54.6% | +11,720 | 6 |
| 21 | 10:35 PM – 10:50 PM | 220 | 197 | 144 (73%) | 53 (27%) | 0 (0%) | 73.1% | +35,396 | 6 |
| 22 | 10:50 PM – 11:05 PM | 359 | 329 | 141 (43%) | 152 (46%) | 36 (11%) | 44.4% | +32,773 | 6 |
| 23 | 11:05 PM – 11:20 PM | 264 | 242 | 51 (21%) | 182 (75%) | 9 (4%) | 21.5% | −14,803 | 6 |
| 24 | 11:20 PM – 11:35 PM | 319 | 302 | 82 (27%) | 211 (70%) | 9 (3%) | 29.5% | −3,816 | 6 |
| 25 | 11:35 PM – 11:50 PM | 212 | 188 | 79 (42%) | 107 (57%) | 2 (1%) | 42.0% | −3,375 | 6 |
| 26 | 11:50 PM – 12:05 AM | 201 | 178 | 116 (65%) | 62 (35%) | 0 (0%) | 65.2% | +14,791 | 7 |
| 27 | 12:05 AM – 12:20 AM | 232 | 212 | 86 (41%) | 87 (41%) | 39 (18%) | 42.0% | −14,213 | 5 |
| 28 | 12:20 AM – 12:35 AM | 216 | 196 | 51 (26%) | 114 (58%) | 31 (16%) | 41.3% | +161 | 5 |
| 29 | 12:35 AM – 12:50 AM | 186 | 172 | 79 (46%) | 91 (53%) | 2 (1%) | 46.5% | −6,327 | 6 |
| 30 | 12:50 AM – 1:05 AM | 236 | 209 | 121 (58%) | 77 (37%) | 11 (5%) | 61.7% | +3,106 | 6 |
| 31 | 1:05 AM – 1:20 AM | 192 | 178 | 71 (40%) | 102 (57%) | 5 (3%) | 41.0% | −1,004 | 5 |
| 32 | 1:20 AM – 1:35 AM | 237 | 204 | 75 (37%) | 122 (60%) | 7 (3%) | 39.7% | +6,947 | 6 |
| 33 | 1:35 AM – 1:50 AM | 185 | 175 | 63 (36%) | 105 (60%) | 7 (4%) | 40.0% | −4,942 | 6 |
| 34 | 1:50 AM – 2:05 AM | 177 | 168 | 69 (41%) | 94 (56%) | 5 (3%) | 41.7% | −850 | 5 |
| 35 | 2:05 AM – 2:20 AM | 203 | 178 | 93 (52%) | 80 (45%) | 5 (3%) | 54.5% | +12,008 | 5 |
| 36 | 2:20 AM – 2:35 AM | 240 | 219 | 106 (48%) | 96 (44%) | 17 (8%) | 55.7% | +26,862 | 6 |
| 37 | 2:35 AM – 2:50 AM | 215 | 197 | 64 (32%) | 115 (58%) | 18 (9%) | 38.1% | +434 | 5 |
| 38 | 2:50 AM – 3:05 AM | 202 | 194 | 70 (36%) | 112 (58%) | 12 (6%) | 42.3% | −1,934 | 5 |
| 39 | 3:05 AM – 3:20 AM | 184 | 172 | 49 (28%) | 105 (61%) | 18 (10%) | 35.5% | −1,376 | 5 |
| 40 | 3:20 AM – 3:35 AM | 220 | 205 | 70 (34%) | 128 (62%) | 7 (3%) | 35.6% | −3,593 | 6 |
| 41 | 3:35 AM – 3:50 AM | 260 | 239 | 91 (38%) | 127 (53%) | 21 (9%) | 46.0% | +14,975 | 5 |
| 42 | 3:50 AM – 4:05 AM | 218 | 205 | 46 (22%) | 157 (77%) | 2 (1%) | 22.4% | −15,041 | 5 |
| 43 | 4:05 AM – 4:20 AM | 182 | 176 | 41 (23%) | 135 (77%) | 0 (0%) | 23.3% | −2,088 | 6 |
| 44 | 4:20 AM – 4:35 AM | 185 | 174 | 68 (39%) | 104 (60%) | 2 (1%) | 40.2% | −1,122 | 6 |
| 45 | 4:35 AM – 4:50 AM | 193 | 180 | 54 (30%) | 126 (70%) | 0 (0%) | 30.0% | −7,386 | 5 |
| 46 | 4:50 AM – 5:05 AM | 204 | 191 | 57 (30%) | 128 (67%) | 6 (3%) | 33.0% | −7,823 | 6 |
| 47 | 5:05 AM – 5:20 AM | 216 | 208 | 59 (28%) | 149 (72%) | 0 (0%) | 28.4% | −11,019 | 6 |
| 48 | 5:20 AM – 5:35 AM | 259 | 224 | 86 (38%) | 136 (61%) | 2 (1%) | 39.3% | −5,617 | 5 |
| 49 | 5:35 AM – 5:50 AM | 240 | 200 | 48 (24%) | 149 (74%) | 3 (2%) | 25.0% | −13,750 | 6 |
| 50 | 5:50 AM – 6:05 AM | 250 | 231 | 50 (22%) | 170 (74%) | 11 (5%) | 23.8% | −16,103 | 6 |
| 51 | 6:05 AM – 6:20 AM | 203 | 173 | 53 (31%) | 111 (64%) | 9 (5%) | 30.6% | −10,724 | 6 |
| 52 | 6:20 AM – 6:35 AM | 231 | 197 | 40 (20%) | 154 (78%) | 3 (2%) | 21.8% | −11,778 | 5 |
| 53 | 6:35 AM – 6:50 AM | 258 | 240 | 77 (32%) | 162 (68%) | 1 (0%) | 32.1% | −17,640 | 5 |
| 54 | 6:50 AM – 7:05 AM | 277 | 258 | 104 (40%) | 128 (50%) | 26 (10%) | 48.4% | −3,056 | 5 |
| 55 | 7:05 AM – 7:20 AM | 252 | 231 | 147 (64%) | 73 (32%) | 11 (5%) | 68.0% | +24,415 | 5 |
| 56 | 7:20 AM – 7:35 AM | 226 | 174 | 120 (69%) | 52 (30%) | 2 (1%) | 70.1% | +30,286 | 5 |
| 57 | 7:35 AM – 7:50 AM | 283 | 248 | 77 (31%) | 166 (67%) | 5 (2%) | 32.7% | +6,680 | 5 |
| 58 | 7:50 AM – 8:05 AM | 217 | 198 | 61 (31%) | 134 (68%) | 3 (2%) | 32.3% | +28 | 5 |
| 59 | 8:05 AM – 8:20 AM | 177 | 140 | 43 (31%) | 95 (68%) | 2 (1%) | 30.7% | −3,596 | 5 |
| 60 | 8:20 AM – 8:35 AM | 235 | 198 | 128 (65%) | 68 (34%) | 2 (1%) | 65.7% | +26,118 | 5 |
| 61 | 8:35 AM – 8:50 AM | 201 | 180 | 77 (43%) | 102 (57%) | 1 (1%) | 43.3% | +8,192 | 5 |
| 62 | 8:50 AM – 9:05 AM | 201 | 166 | 70 (42%) | 96 (58%) | 0 (0%) | 42.2% | +2,121 | 5 |
| 63 | 9:05 AM – 9:20 AM | 190 | 179 | 132 (74%) | 47 (26%) | 0 (0%) | 73.7% | +13,852 | 5 |
| 64 | 9:20 AM – 9:35 AM | 266 | 226 | 148 (65%) | 75 (33%) | 3 (1%) | 66.8% | +43,153 | 5 |
| 65 | 9:35 AM – 9:50 AM | 191 | 165 | 73 (44%) | 92 (56%) | 0 (0%) | 44.2% | +2,748 | 5 |
| 66 | 9:50 AM – 10:05 AM | 269 | 215 | 47 (22%) | 122 (57%) | 46 (21%) | 34.0% | −29,709 | 5 |
| 67 | 10:05 AM – 10:20 AM | 142 | 134 | 45 (34%) | 81 (60%) | 8 (6%) | 39.6% | −7,462 | 5 |
| 68 | 10:20 AM – 10:35 AM | 180 | 161 | 43 (27%) | 114 (71%) | 4 (2%) | 29.2% | −24,228 | 5 |
| 69 | 10:35 AM – 10:50 AM | 168 | 157 | 63 (40%) | 92 (59%) | 2 (1%) | 40.8% | −1,831 | 5 |
| 70 | 10:50 AM – 11:05 AM | 224 | 174 | 98 (56%) | 71 (41%) | 5 (3%) | 56.9% | +1,288 | 5 |
| 71 | 11:05 AM – 11:20 AM | 234 | 190 | 127 (67%) | 60 (32%) | 3 (2%) | 66.8% | +13,356 | 5 |
| 72 | 11:20 AM – 11:35 AM | 161 | 155 | 66 (43%) | 88 (57%) | 1 (1%) | 42.6% | −3,895 | 4 |
| 73 | 11:35 AM – 11:50 AM | 153 | 141 | 62 (44%) | 75 (53%) | 4 (3%) | 46.8% | +1,216 | 4 |
| 74 | 11:50 AM – 12:05 PM | 153 | 137 | 44 (32%) | 91 (66%) | 2 (1%) | 33.6% | −3,528 | 4 |
| 75 | 12:05 PM – 12:20 PM | 166 | 149 | 35 (23%) | 106 (71%) | 8 (5%) | 24.2% | −5,589 | 4 |
| 76 | 12:20 PM – 12:35 PM | 216 | 203 | 48 (24%) | 135 (67%) | 20 (10%) | 24.6% | −23,275 | 4 |
| 77 | 12:35 PM – 12:50 PM | 133 | 123 | 45 (37%) | 78 (63%) | 0 (0%) | 36.6% | −9,523 | 4 |
| 78 | 12:50 PM – 1:05 PM | 136 | 131 | 28 (21%) | 99 (76%) | 4 (3%) | 24.4% | −4,166 | 4 |
| 79 | 1:05 PM – 1:20 PM | 170 | 137 | 27 (20%) | 109 (80%) | 1 (1%) | 20.4% | −9,241 | 4 |
| 80 | 1:20 PM – 1:35 PM | 300 | 268 | 184 (69%) | 74 (28%) | 10 (4%) | 72.0% | +47,570 | 4 |
| 81 | 1:35 PM – 1:50 PM | 172 | 153 | 62 (41%) | 69 (45%) | 22 (14%) | 52.3% | +6,478 | 4 |
| 82 | 1:50 PM – 2:05 PM | 186 | 176 | 47 (27%) | 124 (70%) | 5 (3%) | 29.0% | −6,525 | 4 |
| 83 | 2:05 PM – 2:20 PM | 175 | 153 | 70 (46%) | 82 (54%) | 1 (1%) | 46.4% | +650 | 4 |
| 84 | 2:20 PM – 2:35 PM | 154 | 149 | 53 (36%) | 96 (64%) | 0 (0%) | 35.6% | +638 | 4 |
| 85 | 2:35 PM – 2:50 PM | 207 | 183 | 85 (46%) | 92 (50%) | 6 (3%) | 47.0% | +2,700 | 5 |
| 86 | 2:50 PM – 3:05 PM | 263 | 233 | 128 (55%) | 92 (39%) | 13 (6%) | 59.2% | +10,149 | 5 |
| 87 | 3:05 PM – 3:20 PM | 194 | 182 | 60 (33%) | 115 (63%) | 7 (4%) | 36.8% | −651 | 5 |
| 88 | 3:20 PM – 3:35 PM | 244 | 238 | 96 (40%) | 140 (59%) | 2 (1%) | 41.2% | +7,383 | 5 |
| 89 | 3:35 PM – 3:50 PM | 226 | 208 | 77 (37%) | 131 (63%) | 0 (0%) | 37.0% | −201 | 5 |
| 90 | 3:50 PM – 4:05 PM | 248 | 225 | 68 (30%) | 155 (69%) | 2 (1%) | 30.2% | −2,764 | 5 |
| 91 | 4:05 PM – 4:20 PM | 222 | 212 | 69 (33%) | 140 (66%) | 3 (1%) | 33.5% | −8,819 | 5 |
| 92 | 4:20 PM – 4:35 PM | 268 | 235 | 71 (30%) | 159 (68%) | 5 (2%) | 31.9% | −379 | 5 |
| 93 | 4:35 PM – 4:50 PM | 245 | 227 | 74 (33%) | 152 (67%) | 1 (0%) | 32.6% | −4,150 | 5 |
| 94 | 4:50 PM – 5:05 PM | 220 | 216 | 102 (47%) | 114 (53%) | 0 (0%) | 47.2% | −2,679 | 5 |
| 95 | 5:05 PM – 5:20 PM | 151 | 125 | 49 (39%) | 76 (61%) | 0 (0%) | 39.2% | −3,197 | 5 |
| 96 | 5:20 PM – 5:30 PM \* | 0 | 0 | – | – | – | – | 0 | 0 |

\* The last slot is 10 minutes (5:20 PM up to the 5:30 PM settlement).

## By method

Every method, in the desk's own order. "Avg pts" is net points per closed trade. Look at **Closed** first: a method with a handful of trades can show any win rate.

| Method | Signals | Closed | Target hit | SL hit | Timed out | Win rate | Net pts | Avg pts |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| #1 Breakout | 294 | 285 | 100 (35%) | 174 (61%) | 11 (4%) | 36.1% | +1,157 | +4 |
| #2 Breakout + retest | 244 | 140 | 55 (39%) | 85 (61%) | 0 (0%) | 39.3% | +1,107 | +8 |
| #3 Liquidity sweep | 60 | 51 | 13 (25%) | 26 (51%) | 12 (24%) | 41.2% | +572 | +11 |
| #4 FVG retest | 302 | 215 | 79 (37%) | 129 (60%) | 7 (3%) | 37.7% | −5,354 | −25 |
| #5 Order-block retest | 155 | 88 | 29 (33%) | 57 (65%) | 2 (2%) | 34.1% | −1,390 | −16 |
| #6 BOS | 98 | 86 | 30 (35%) | 43 (50%) | 13 (15%) | 43.0% | +3,409 | +40 |
| #7 MSS / CHoCH | 4 | 4 | 2 (50%) | 1 (25%) | 1 (25%) | 75.0% | +1,040 | +260 |
| #8 Momentum | 78 | 75 | 32 (43%) | 31 (41%) | 12 (16%) | 49.3% | +919 | +12 |
| #9 Pullback | 305 | 298 | 125 (42%) | 159 (53%) | 14 (5%) | 45.0% | +8,938 | +30 |
| #10 VWAP / mean reversion | 138 | 131 | 53 (40%) | 66 (50%) | 12 (9%) | 49.6% | −1,160 | −9 |
| #11 Order flow | 822 | 634 | 237 (37%) | 396 (62%) | 1 (0%) | 37.5% | −515 | −1 |
| #12 Options / derivatives | 157 | 141 | 67 (48%) | 68 (48%) | 6 (4%) | 50.4% | +5,263 | +37 |
| #13 Compression break | 50 | 49 | 13 (27%) | 18 (37%) | 18 (37%) | 46.9% | +741 | +15 |
| #14 Failed breakout / breakdown (trap) | 405 | 383 | 194 (51%) | 184 (48%) | 5 (1%) | 51.4% | −10,024 | −26 |
| #15 Opening-range breakout (Asia · London · New York) | 50 | 48 | 21 (44%) | 23 (48%) | 4 (8%) | 45.8% | +2,279 | +47 |
| #16 Previous day H/L rejection | 43 | 40 | 24 (60%) | 11 (28%) | 5 (12%) | 65.0% | +8,180 | +204 |
| #17 Previous day H/L break & hold | 21 | 21 | 9 (43%) | 12 (57%) | 0 (0%) | 42.9% | +166 | +8 |
| #18 Previous-day range expansion | 47 | 45 | 10 (22%) | 28 (62%) | 7 (16%) | 31.1% | −2,144 | −48 |
| #19 VWAP reclaim / loss | 367 | 349 | 121 (35%) | 207 (59%) | 21 (6%) | 38.1% | +4,825 | +14 |
| #20 Anchored VWAP (week) | 25 | 24 | 11 (46%) | 13 (54%) | 0 (0%) | 45.8% | +981 | +41 |
| #21 Value-area break | 6 | 6 | 4 (67%) | 2 (33%) | 0 (0%) | 66.7% | +1,023 | +171 |
| #22 POC reclaim / loss | 9 | 9 | 4 (44%) | 5 (56%) | 0 (0%) | 44.4% | −412 | −46 |
| #23 CVD divergence | 207 | 193 | 54 (28%) | 103 (53%) | 36 (19%) | 33.2% | −7,783 | −40 |
| #24 Delta divergence | 124 | 119 | 34 (29%) | 71 (60%) | 14 (12%) | 38.7% | −4,672 | −39 |
| #25 Exhaustion reversal | 52 | 51 | 25 (49%) | 24 (47%) | 2 (4%) | 52.9% | +2,379 | +47 |
| #26 Equal H/L sweep & reclaim | 309 | 298 | 112 (38%) | 153 (51%) | 33 (11%) | 46.0% | +12,036 | +40 |
| #27 Session H/L sweep (Asia · London · New York) | 24 | 23 | 6 (26%) | 12 (52%) | 5 (22%) | 34.8% | −1,188 | −52 |
| #28 Funding + price divergence | 0 | 0 | – | – | – | – | – | – |
| #29 OI-confirmed breakout | 277 | 260 | 90 (35%) | 166 (64%) | 4 (2%) | 35.0% | −3,925 | −15 |
| #30 OI flush reversal | 100 | 98 | 36 (37%) | 53 (54%) | 9 (9%) | 45.9% | +706 | +7 |
| #31 Expected-move edge reaction | 82 | 68 | 6 (9%) | 32 (47%) | 30 (44%) | 52.9% | +7,762 | +114 |
| #32 Volatility regime transition | 26 | 25 | 11 (44%) | 14 (56%) | 0 (0%) | 44.0% | +1,041 | +42 |
| #33 Z-score reversion | 235 | 228 | 94 (41%) | 121 (53%) | 13 (6%) | 46.5% | −7,590 | −33 |
| #34 Multi-factor regime entry | 20 | 20 | 10 (50%) | 9 (45%) | 1 (5%) | 50.0% | +753 | +38 |
| #35 Mid-range rejection | 43 | 43 | 24 (56%) | 19 (44%) | 0 (0%) | 55.8% | −481 | −11 |
| #36 Trendline break & retest | 158 | 142 | 49 (35%) | 93 (65%) | 0 (0%) | 34.5% | −4,072 | −29 |
| #37 Channel breakout | 418 | 408 | 153 (38%) | 246 (60%) | 9 (2%) | 38.2% | +260 | +1 |
| #38 Engulfing + structure | 238 | 226 | 97 (43%) | 124 (55%) | 5 (2%) | 43.4% | +1,537 | +7 |
| #39 NR7 / inside-bar break | 587 | 559 | 251 (45%) | 301 (54%) | 7 (1%) | 45.4% | +8,757 | +16 |
| #40 Dislocation reversion | 41 | 41 | 28 (68%) | 13 (32%) | 0 (0%) | 68.3% | +85 | +2 |
| #41 Basis divergence (perp vs index) | 83 | 68 | 40 (59%) | 28 (41%) | 0 (0%) | 58.8% | −2,640 | −39 |
| #42 Index leads, perp lags | 0 | 0 | – | – | – | – | – | – |
| #43 Mark-perp divergence | 54 | 31 | 12 (39%) | 19 (61%) | 0 (0%) | 38.7% | −2,883 | −93 |
| #44 Forced-flow continuation (liquidation proxy) | 104 | 95 | 30 (32%) | 63 (66%) | 2 (2%) | 32.6% | −2,025 | −21 |
| #45 OI wall break & retest | 7 | 6 | 0 (0%) | 6 (100%) | 0 (0%) | 0.0% | −621 | −104 |
| #46 Funding flip | 40 | 37 | 4 (11%) | 33 (89%) | 0 (0%) | 10.8% | −1,567 | −42 |
| #47 IV expansion breakout | 132 | 123 | 40 (33%) | 75 (61%) | 8 (7%) | 35.0% | −2,401 | −20 |
| #48 IV crush reversion | 6 | 6 | 1 (17%) | 5 (83%) | 0 (0%) | 16.7% | −1,216 | −203 |
| #49 Options skew divergence | 49 | 47 | 8 (17%) | 38 (81%) | 1 (2%) | 19.1% | −4,454 | −95 |
| #50 Gamma wall reaction | 1,039 | 996 | 406 (41%) | 541 (54%) | 49 (5%) | 43.5% | +26,288 | +26 |
| #51 Expiry pin / max-pain magnet | 25 | 22 | 17 (77%) | 5 (23%) | 0 (0%) | 77.3% | +1,195 | +54 |
| #52 Order-book imbalance breakout | 198 | 168 | 62 (37%) | 103 (61%) | 3 (2%) | 37.5% | +4,368 | +26 |
| #53 Microprice / queue imbalance | 1,462 | 1,239 | 490 (40%) | 735 (59%) | 14 (1%) | 40.2% | +8,125 | +7 |
| #54 Liquidity replenishment | 2,461 | 2,334 | 896 (38%) | 1,314 (56%) | 124 (5%) | 42.0% | +11,007 | +5 |
| #55 Pulled wall (spoof / pull) | 5,341 | 4,691 | 1,806 (38%) | 2,862 (61%) | 23 (0%) | 38.9% | +11,670 | +2 |
| #56 Big-print follow-through | 231 | 225 | 74 (33%) | 142 (63%) | 9 (4%) | 34.7% | −2,908 | −13 |
| #57 Trade velocity / aggression spike | 47 | 45 | 22 (49%) | 9 (20%) | 14 (31%) | 64.4% | +5,620 | +125 |
| #58 CVD regime shift | 183 | 174 | 52 (30%) | 84 (48%) | 38 (22%) | 39.7% | +1,378 | +8 |
| #59 Footprint stacked imbalance -- continuation | 1,454 | 1,399 | 532 (38%) | 832 (59%) | 35 (3%) | 39.6% | +2,879 | +2 |
| #60 Footprint stacked imbalance -- reversal | 260 | 251 | 81 (32%) | 166 (66%) | 4 (2%) | 33.5% | −8,413 | −34 |
| #61 Naked POC reaction | 16 | 14 | 2 (14%) | 11 (79%) | 1 (7%) | 21.4% | −490 | −35 |
| #62 Initial balance break | 20 | 19 | 10 (53%) | 9 (47%) | 0 (0%) | 52.6% | +510 | +27 |
| #63 Initial balance failed break | 205 | 179 | 145 (81%) | 29 (16%) | 5 (3%) | 81.6% | +4,875 | +27 |
| #64 Previous week H/L sweep | 0 | 0 | – | – | – | – | – | – |
| #65 Previous month H/L sweep | 0 | 0 | – | – | – | – | – | – |
| #66 Weekly range expansion | 0 | 0 | – | – | – | – | – | – |
| #67 Monthly range expansion | 0 | 0 | – | – | – | – | – | – |
| #68 Previous week H/L break-reclaim | 0 | 0 | – | – | – | – | – | – |
| #69 Previous month H/L break-reclaim | 0 | 0 | – | – | – | – | – | – |
| #70 Option volume one-sided | 68 | 62 | 22 (35%) | 40 (65%) | 0 (0%) | 35.5% | −1,174 | −19 |
| #71 Call / put OI divergence | 407 | 399 | 142 (36%) | 231 (58%) | 26 (7%) | 40.6% | −8,724 | −22 |
| #72 IV vs realised volatility | 223 | 216 | 68 (31%) | 137 (63%) | 11 (5%) | 33.3% | −613 | −3 |
| #73 Term-structure inversion | 26 | 26 | 14 (54%) | 11 (42%) | 1 (4%) | 53.8% | +4,338 | +167 |
| #74 Expiry OI migration | 33 | 27 | 9 (33%) | 16 (59%) | 2 (7%) | 37.0% | −1,655 | −61 |
| #75 Volatility z-score spike | 5 | 5 | 0 (0%) | 5 (100%) | 0 (0%) | 0.0% | −1,400 | −280 |
| #76 Volume z-score spike | 117 | 109 | 35 (32%) | 66 (61%) | 8 (7%) | 33.9% | −7,007 | −64 |
| #77 Autocorrelation regime entry | 26 | 24 | 8 (33%) | 14 (58%) | 2 (8%) | 41.7% | −671 | −28 |
| #78 Range-efficiency entry | 21 | 18 | 3 (17%) | 7 (39%) | 8 (44%) | 38.9% | −1,584 | −88 |
| #79 Trend-efficiency break | 24 | 23 | 12 (52%) | 9 (39%) | 2 (9%) | 60.9% | +4,643 | +202 |
| #80 Correlation breakdown (BTC vs ETH) | 0 | 0 | – | – | – | – | – | – |
| #81 BTC vs ETH divergence | 60 | 58 | 16 (28%) | 36 (62%) | 6 (10%) | 37.9% | −2,595 | −45 |

### The methods that won and lost the most points (at least 100 closed trades)

| Rank | Method | Closed | Win rate | Net pts | Avg pts |
|--:|---|--:|--:|--:|--:|
| Top 1 | #50 Gamma wall reaction | 996 | 43.5% | +26,288 | +26 |
| Top 2 | #26 Equal H/L sweep & reclaim | 298 | 46.0% | +12,036 | +40 |
| Top 3 | #55 Pulled wall (spoof / pull) | 4,691 | 38.9% | +11,670 | +2 |
| Top 4 | #54 Liquidity replenishment | 2,334 | 42.0% | +11,007 | +5 |
| Top 5 | #9 Pullback | 298 | 45.0% | +8,938 | +30 |
| Top 6 | #39 NR7 / inside-bar break | 559 | 45.4% | +8,757 | +16 |
| Top 7 | #53 Microprice / queue imbalance | 1,239 | 40.2% | +8,125 | +7 |
| Top 8 | #12 Options / derivatives | 141 | 50.4% | +5,263 | +37 |
| Bottom 1 | #14 Failed breakout / breakdown (trap) | 383 | 51.4% | −10,024 | −26 |
| Bottom 2 | #71 Call / put OI divergence | 399 | 40.6% | −8,724 | −22 |
| Bottom 3 | #60 Footprint stacked imbalance -- reversal | 251 | 33.5% | −8,413 | −34 |
| Bottom 4 | #23 CVD divergence | 193 | 33.2% | −7,783 | −40 |
| Bottom 5 | #33 Z-score reversion | 228 | 46.5% | −7,590 | −33 |
| Bottom 6 | #76 Volume z-score spike | 109 | 33.9% | −7,007 | −64 |
| Bottom 7 | #4 FVG retest | 215 | 37.7% | −5,354 | −25 |
| Bottom 8 | #24 Delta divergence | 119 | 38.7% | −4,672 | −39 |

## Each method by time of day

The session in six four-hour parts: **Evening** 5:35 PM – 9:35 PM, **Night** 9:35 PM – 1:35 AM, **Late night** 1:35 AM – 5:35 AM, **Morning** 5:35 AM – 9:35 AM, **Midday** 9:35 AM – 1:35 PM, **Afternoon** 1:35 PM – 5:30 PM.
Each cell is the win rate and, in brackets, the closed trades behind it. A dash means fewer than 10 trades: too few to show.

| Method | Evening | Night | Late night | Morning | Midday | Afternoon |
|---|--:|--:|--:|--:|--:|--:|
| #1 Breakout | 37% (51) | 40% (50) | 36% (42) | 32% (63) | 38% (50) | 34% (29) |
| #2 Breakout + retest | 53% (17) | 43% (30) | 23% (31) | 43% (28) | 45% (20) | 36% (14) |
| #3 Liquidity sweep | 54% (13) | – | – | 29% (14) | – | – |
| #4 FVG retest | 48% (33) | 45% (38) | 42% (36) | 37% (41) | 23% (26) | 29% (41) |
| #5 Order-block retest | 39% (18) | 35% (17) | – | 33% (18) | 42% (12) | 29% (14) |
| #6 BOS | 45% (20) | 48% (25) | – | 46% (13) | 27% (11) | – |
| #7 MSS / CHoCH | – | – | – | – | – | – |
| #8 Momentum | 41% (17) | 20% (10) | 75% (12) | 50% (14) | 45% (11) | 64% (11) |
| #9 Pullback | 31% (55) | 59% (87) | 29% (51) | 41% (34) | 51% (39) | 53% (32) |
| #10 VWAP / mean reversion | 41% (27) | 50% (36) | 30% (20) | 75% (28) | 47% (17) | – |
| #11 Order flow | 27% (107) | 39% (111) | 49% (125) | 34% (96) | 32% (82) | 41% (113) |
| #12 Options / derivatives | 44% (43) | – | – | – | 47% (19) | 53% (70) |
| #13 Compression break | 30% (10) | – | – | – | 53% (15) | – |
| #14 Failed breakout / breakdown (trap) | 64% (69) | 40% (77) | 32% (68) | 58% (67) | 64% (45) | 56% (57) |
| #15 Opening-range breakout (Asia · London · New York) | 44% (16) | – | – | 35% (20) | 64% (11) | – |
| #16 Previous day H/L rejection | – | 83% (18) | – | – | – | – |
| #17 Previous day H/L break & hold | 0% (10) | – | – | – | – | – |
| #18 Previous-day range expansion | 58% (12) | 8% (12) | 27% (11) | – | – | – |
| #19 VWAP reclaim / loss | 43% (67) | 43% (21) | 14% (35) | 38% (112) | 41% (64) | 44% (50) |
| #20 Anchored VWAP (week) | – | – | – | – | – | 30% (10) |
| #21 Value-area break | – | – | – | – | – | – |
| #22 POC reclaim / loss | – | – | – | – | – | – |
| #23 CVD divergence | 43% (47) | 22% (40) | 27% (33) | 48% (21) | 18% (17) | 37% (35) |
| #24 Delta divergence | 41% (22) | 13% (30) | 28% (18) | 56% (18) | 50% (12) | 63% (19) |
| #25 Exhaustion reversal | 50% (24) | – | – | – | – | – |
| #26 Equal H/L sweep & reclaim | 43% (98) | 31% (32) | 42% (45) | 53% (64) | 58% (24) | 51% (35) |
| #27 Session H/L sweep (Asia · London · New York) | 20% (10) | – | – | – | – | – |
| #29 OI-confirmed breakout | 23% (47) | 35% (66) | 9% (11) | 43% (61) | 48% (48) | 26% (27) |
| #30 OI flush reversal | 50% (16) | 29% (17) | 45% (22) | 65% (17) | 31% (13) | 54% (13) |
| #31 Expected-move edge reaction | – | 64% (22) | – | 92% (13) | – | 22% (18) |
| #32 Volatility regime transition | – | – | – | – | – | – |
| #33 Z-score reversion | 54% (59) | 50% (34) | 42% (24) | 50% (54) | 36% (33) | 33% (24) |
| #34 Multi-factor regime entry | – | – | 73% (11) | – | – | – |
| #35 Mid-range rejection | 50% (10) | – | – | 55% (11) | – | – |
| #36 Trendline break & retest | 41% (41) | 29% (17) | 30% (23) | 35% (23) | 29% (21) | 35% (17) |
| #37 Channel breakout | 42% (97) | 32% (53) | 48% (50) | 35% (81) | 43% (83) | 23% (44) |
| #38 Engulfing + structure | 39% (41) | 44% (43) | 40% (30) | 52% (50) | 53% (32) | 27% (30) |
| #39 NR7 / inside-bar break | 45% (78) | 43% (110) | 45% (114) | 49% (102) | 40% (73) | 51% (82) |
| #40 Dislocation reversion | 67% (12) | – | – | – | 79% (14) | – |
| #41 Basis divergence (perp vs index) | 50% (28) | 27% (11) | 83% (12) | – | – | – |
| #43 Mark-perp divergence | – | 23% (13) | – | – | – | – |
| #44 Forced-flow continuation (liquidation proxy) | 20% (15) | 59% (17) | 39% (33) | 21% (14) | – | – |
| #45 OI wall break & retest | – | – | – | – | – | – |
| #46 Funding flip | – | – | 16% (19) | – | – | – |
| #47 IV expansion breakout | 21% (19) | 26% (19) | 60% (30) | 36% (28) | 18% (11) | 25% (16) |
| #48 IV crush reversion | – | – | – | – | – | – |
| #49 Options skew divergence | 0% (12) | – | 0% (15) | – | – | 36% (11) |
| #50 Gamma wall reaction | 36% (240) | 74% (98) | 53% (66) | 69% (71) | 27% (195) | 42% (326) |
| #51 Expiry pin / max-pain magnet | – | – | – | – | – | 77% (22) |
| #52 Order-book imbalance breakout | 33% (33) | 55% (44) | 24% (41) | 30% (10) | 44% (18) | 32% (22) |
| #53 Microprice / queue imbalance | 38% (225) | 45% (265) | 37% (201) | 41% (198) | 44% (161) | 36% (189) |
| #54 Liquidity replenishment | 37% (393) | 52% (459) | 33% (406) | 42% (408) | 46% (306) | 41% (362) |
| #55 Pulled wall (spoof / pull) | 33% (878) | 45% (839) | 39% (865) | 40% (787) | 38% (641) | 40% (681) |
| #56 Big-print follow-through | 27% (48) | 32% (37) | 44% (36) | 42% (45) | 44% (27) | 19% (32) |
| #57 Trade velocity / aggression spike | 31% (13) | – | – | 70% (10) | – | – |
| #58 CVD regime shift | 37% (30) | 45% (40) | 27% (22) | 49% (35) | 64% (22) | 12% (25) |
| #59 Footprint stacked imbalance -- continuation | 37% (293) | 49% (264) | 39% (244) | 42% (218) | 38% (178) | 32% (202) |
| #60 Footprint stacked imbalance -- reversal | 35% (66) | 44% (34) | 30% (61) | 23% (31) | 42% (43) | 19% (16) |
| #61 Naked POC reaction | – | – | – | 18% (11) | – | – |
| #62 Initial balance break | – | – | – | 53% (19) | – | – |
| #63 Initial balance failed break | 81% (16) | 84% (25) | – | 94% (77) | 71% (52) | – |
| #70 Option volume one-sided | – | 0% (10) | 58% (24) | 22% (18) | – | – |
| #71 Call / put OI divergence | 42% (64) | 23% (79) | 33% (76) | 62% (60) | 37% (51) | 52% (69) |
| #72 IV vs realised volatility | 53% (36) | 36% (81) | 9% (11) | 29% (35) | 22% (18) | 26% (35) |
| #73 Term-structure inversion | 72% (18) | – | – | – | – | – |
| #74 Expiry OI migration | 37% (27) | – | – | – | – | – |
| #75 Volatility z-score spike | – | – | – | – | – | – |
| #76 Volume z-score spike | 28% (36) | 10% (10) | 31% (13) | 50% (22) | 42% (19) | – |
| #77 Autocorrelation regime entry | – | – | – | – | – | – |
| #78 Range-efficiency entry | – | – | – | – | – | – |
| #79 Trend-efficiency break | – | – | – | – | – | – |
| #81 BTC vs ETH divergence | 20% (10) | 30% (10) | 25% (16) | – | – | – |

## With and without the timeframe chain

| Way | Closed | Target hit | SL hit | Timed out | Win rate | Net pts | Avg pts |
|---|--:|--:|--:|--:|--:|--:|--:|
| With the timeframe chain | 2,649 | 1,077 (41%) | 1,453 (55%) | 119 (4%) | 43.7% | +23,369 | +9 |
| Without the chain · 1m | 76 | 48 (63%) | 28 (37%) | 0 (0%) | 63.2% | −651 | −9 |
| Without the chain · 3m | 7,536 | 2,680 (36%) | 4,551 (60%) | 305 (4%) | 37.9% | −90,589 | −12 |
| Without the chain · 5m | 5,137 | 1,903 (37%) | 3,025 (59%) | 209 (4%) | 39.6% | −42,610 | −8 |
| Without the chain · 15m | 1,851 | 782 (42%) | 1,027 (55%) | 42 (2%) | 43.9% | +27,819 | +15 |
| Without the chain · 30m | 1,058 | 506 (48%) | 528 (50%) | 24 (2%) | 49.1% | +62,694 | +59 |
| Without the chain · 1h | 609 | 298 (49%) | 295 (48%) | 16 (3%) | 50.2% | +45,822 | +75 |
| Without the chain · 2h | 2 | 0 (0%) | 2 (100%) | 0 (0%) | 0.0% | −466 | −233 |
| Without the chain · 4h | 142 | 78 (55%) | 64 (45%) | 0 (0%) | 54.9% | +31,670 | +223 |

The 1m row is small because 1m stopped giving signals on 1 Oct, and the 2h row because 2h was only added on 6 Oct.

## Each method in each 15-minute slot

The full breakdown is a separate file, because it is 3,155 rows: [signal-history-by-method-and-slot.md](signal-history-by-method-and-slot.md). Only 465 of those method-and-slot pairs have 10 or more trades; the rest are marked as too few to read.

## How this was made

- **Source:** the desk's paper log (`entry_setups`), the record behind the Signal history and Methods screens: 21,202 TRADE signals, read without changing anything.
- **Slot:** by the time the signal first appeared, in IST. Slots are the same as in the BTC movement report: 5:35–5:50 PM, 5:50–6:05 PM and so on.
- **Left out:** 154 signals that appeared between 5:30 PM and 5:35 PM (settlement), which is in no slot.
- **Win** is a closed trade with a positive result, as the Methods screen counts it. **Net pts** is exit minus fill in the trade's direction, summed.
- **5.7 days is a small sample.** Nothing here was tested out of sample, and no strategy was run on it.
