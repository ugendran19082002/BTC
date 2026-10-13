# The market report

Since 13 Oct 2026. "Every day, the market's trend -- 5:31 PM to 5:29 PM, how the whole expiry went -- and on
that, which pair is best": each expiry day of the BTC perp measured and given one of twenty names, and against
the kind of day, what the **signal history** and the **real orders** made on it.

Where: the phone, **More → Market report**; the desk, at the bottom of the **Methods** screen. One component
(`app/web/src/components/report/MarketReport.tsx`), two routes (`/api/market-report`,
`/api/market-report/breakdown`), read-only.

## An expiry day

The daily option settles at 5:30 PM IST, so a day runs from 5:30 PM IST to 5:30 PM IST and is named for the
date it ends on (`sessionOf`, `sessionDayOf` in `app/server/src/report/market-day.ts`). The day in progress is
shown too, marked, with its figures so far. A trade is counted in the day it was **entered** in: a signal by its
fill on the perp, an order by its first entry fill.

## The figures of a day

From the desk's own one-minute tape of the perp (`trade_flow_1m`: high, low, and the minute's volume-weighted
price taken as its close). A finished day is worked out once and kept (`market_days`); a day with under ten
hours of tape has no figures and says so.

| Figure | What it is |
|---|---|
| High, low, high − low | The day's extremes and the points between them; also as a share of the open. |
| Open → close | The net move, signed. |
| Most above / below the open | How far each side of the open it went. |
| Zigzag swings, zigzag total | A swing is a move of 0.25% of the price (about 210 points) against the one before, on 5-minute closes. Swings are the turns; the total is every leg added up -- the path the price walked. |
| ATR (15m candles) | The mean true range of the day's 15-minute candles. |
| ATR percentile | Where that ATR stands among the up-to-30 expiry days before, 0-100. Needs five days before. |
| Candle expansion ratio | The largest 15-minute candle's true range over the day's median one. |
| Volatility expansion ratio | The day's ATR over the mean ATR of the five days before: over 1 is expanding. |
| More figures | Times of the high and low, the largest candle, largest and average swing, path over range, trend efficiency, the day in thirds, late against early candles, minutes of tape. |

## The twenty kinds of day

The owner's list, by its own numbers. The first rule that fits names the day (`classify`); every threshold is
in `RULES` in `market-day.ts`, set against the 24 expiry days from 20 Sep to 13 Oct 2026. Changing one means
raising `MARKET_DAY_VERSION`, which has every kept day named again.

| Order | Rule | Name |
|---|---|---|
| 1 | The first 60% of the day inside 40% of its range, and the close 30% of the range outside that | 19 COMPRESSION_BREAKOUT |
| 2 | One 15-minute candle of 1.2% of the price and 45% of the day's range | 20 VOLATILITY_SPIKE |
| 3 | **A trend day**: closed 45% of its range from the open, and 0.6% of the price | |
| 3a | ... having given 35-60% of its run back, its extreme made before 85% of the day | 18 TREND_EXHAUSTION |
| 3b | ... the last third inside 30% of the range and moving under 10% of it | 11 UPTREND_RANGE · 12 DOWNTREND_RANGE |
| 3c | ... a quiet middle third, then 25% of the range again the same way | 13 UPTREND_BREAKOUT · 14 DOWNTREND_BREAKDOWN |
| 3d | ... largest move against it ≥ 45% of the range, or path ≥ 6× the range | 3 UP_TREND_HIGH_ZIGZAG · 6 DOWN_TREND_HIGH_ZIGZAG |
| 3e | ... largest move against it ≤ 25% and path ≤ 3× | 1 UP_TREND_CLEAN · 4 DOWN_TREND_CLEAN |
| 3f | ... otherwise | 2 UP_TREND_ZIGZAG · 5 DOWN_TREND_ZIGZAG |
| 4 | **Not a trend day** | |
| 4a | ATR in the lowest fifth of the days before (too few before: a range under 1.2%) | 10 RANGE_LOW_VOLATILITY |
| 4b | A range ≥ 2.5%, 60% of it one way from the open, 60% of that leg taken back, turning between 15% and 85% of the day | 16 REVERSAL_ZIGZAG |
| 4c | Past the first third's range by 10% of the day's, and closed back inside it | 15 FALSE_BREAKOUT_RANGE |
| 4d | A range ≥ 2.5% | 9 RANGE_WIDE_ZIGZAG |
| 4e | Path ≥ 5× the range | 17 SIDEWAYS_CHOPPY |
| 4f | Path ≥ 3.5× the range | 8 RANGE_ZIGZAG |
| 4g | Otherwise | 7 RANGE_CLEAN |

Four **families** group them, because with a dozen days on record most kinds have one day or two: Up trend
(1, 2, 3, 11, 13), Down trend (4, 5, 6, 12, 14), Range (7, 8, 9, 10, 15, 17), Turn / event (16, 18, 19, 20).
Every group carries its count of days.

## The two records

Never added together: one is shown in the lists at a time (the switch at the top), and each day and each kind
of day says both in a line.

| | Signal history | Real orders |
|---|---|---|
| What | Every signal that went "in the trade" (`entry_setups`), whether or not an order was placed | What the strategies really placed on those signals (`trades`, `plan.signal`) |
| Unit | BTC perp points from fill to exit, and R; no charges | Rupees after charges (`closedNet`) |
| Closed by | Perp TGT (`tp1`), Perp SL (`stop`), Timed out | Perp TGT, Perp SL, Option TGT, Option SL, Window end, By hand (`exitByOf`) |
| Account | none | `?account=`; every account without it |

## What is on the screen

1. **Filters**: since 1 Oct / 7 days / 30 days; real orders / signal history; time frames (`chain` is the
   timeframe chain); methods; strategies (by the name an order was placed under -- they narrow the orders only).
2. **What stands out**, for the record chosen: the family that made the most and the one that lost the most,
   the exit that paid and the exit that cost, the best and worst pair, the best and worst day.
3. **Market report**: the families as tiles, both records' totals, and which exit closed the trades (count,
   share, net).
4. **By kind of day**: each kind (or family) that happened, its days, both records, its best and worst pair;
   opened, its exits, every pair in profit and in loss, by time frame and by strategy.
5. **Each expiry day**, newest first: its kind and one sentence of why, the day as a line with its high and low
   marked, the figures, both records; opened, the same breakdown for that day alone.

## The API

`GET /api/market-report?from=&to=&account=&tf=&method=&strategy=` -- `days` (each with `stats`, `pattern`,
`why`, `family`, `signal`, `real`), `total`, `ends` (the range's three best and worst pairs in each record),
`patterns`, `families`, `catalogue` (the twenty), `choices` (what there is to filter by). `from` and `to` are
expiry days; without them, 1 Oct 2026 to the day in progress; at most 190 days.

`GET /api/market-report/breakdown` with the same, and one of `?day=`, `?pattern=`, `?family=` (none: the whole
range) -- `signal` and `real`, each with `total`, `pairs`, `byTf`, `byMethod`, `byStrategy`.

A day's trades are added up in memory and kept for a minute while the day can still change -- twelve hours past
its settlement for orders, four days for signals -- and for good after. Thirteen days read in about a second
cold and under a tenth of one after.
