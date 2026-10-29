# The market report

Since 13 Oct 2026. "Every day, the market's trend -- 5:31 PM to 5:29 PM, how the whole expiry went -- and on
that, which pair is best": each expiry day of the BTC perp measured and given one of twenty names, and against
the kind of day, what the **signal history** and the **real orders** made on it.

Where: the phone, **More → Market report**; the desk, its own **Market report** menu (it sat under Methods for an hour on 13 Oct). One component
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

Four **families** group them (`familyOf`): Up trend (1, 2, 3, 11, 13), Down trend (4, 5, 6, 12, 14), Range
(7, 8, 9, 10, 15, 17), Turn / event (16, 18, 19, 20). The report itself no longer groups by them (below); the
[backtest](signal-backtest.md) does, under **By kind of day**.

## The two records

Never added together: each day says both in a line, and a day opened shows one at a time (the switch inside it).

| | Signal history | Real orders |
|---|---|---|
| What | Every signal that went "in the trade" (`entry_setups`), whether or not an order was placed | What the strategies really placed on those signals (`trades`, `plan.signal`) |
| Unit | BTC perp points from fill to exit, and R; no charges | Rupees after charges (`closedNet`) |
| Closed by | Perp TGT (`tp1`), Perp SL (`stop`), Timed out | Perp TGT, Perp SL, Option TGT, Option SL, Window end, By hand (`exitByOf`) |
| Account | none | `?account=`; every account without it |

## What is on the screen

Since the evening of 13 Oct 2026 ("only the each-expiry-day, newest-first section; nothing else"), one thing:

- the range -- since 1 Oct, 7 days, 30 days, or **Custom** expiry days -- and, on a desk with more than one
  trading account, whose orders;
- **Each expiry day**, newest first: its kind and one sentence of why, the day as a line with its high and low
  marked, the figures, and both records in a line. Opened: for that day alone, which exit closed the trades,
  every pair in profit and in loss, by time frame, by method and by strategy -- for the record the switch inside
  it shows (real orders or signal history).

Gone with that request: the filters by time frame, method and strategy, "What stands out", the family tiles and
the range's totals panel, and "By kind of day". Their sums are still what the backtest reads a strategy's real
orders through (`ReportFilters`, kept inside `market-report.ts`).

**Added on 29 Oct 2026** (owner: "the market report on the phone -- the P&L there, an account tab, and from time to
time, e.g. 5:31 PM to 5:29 PM, one contract by default, changeable, saved, user friendly on a phone"):

- **Account chips** over the report on the phone (All accounts and each trading account), as History and
  Strategies have; before, the report read whatever account was chosen on another screen, without saying so.
- **Trades entered**, a time window of each expiry day: From and To on the phone's own time wheel, 5:31 PM → 5:29 PM
  (the whole contract) to begin with, applied with a tap -- a window whose end comes before its start in the
  contract's day is refused in words -- and one tap back to the whole contract. Only the trades entered in it are
  counted, in both records, on the days and in an opened day; the day's figures and its kind stay the whole day's.
  Kept with the report's other choices (`useSynced`, `marketReport.window`): on the phone at once, and by the desk
  where the session may write. Each day card says the window when it is not the whole contract.
- **P&L · real orders** on top: the range's money after charges in the window, trades and how many are open, won,
  the best and the worst day, and the signal history's points in a line under it, never added in. In each day card
  the real orders' line comes first and larger.

The whole contract by default is 5:31 PM to 5:29 PM as asked: a trade entered in the settlement minute itself
(5:30 PM) is outside it. The strategies take no entry then (their windows open at 7:00 AM).

## The API

`GET /api/market-report?from=&to=&account=&fromTime=&toTime=` -- `days` (each with `stats`, `pattern`, `why`, `family`, `signal`,
`real`), `total`, `catalogue` (the twenty). `from` and `to` are expiry days; without them, 1 Oct 2026 to the day
in progress; at most 190 days. `fromTime` / `toTime` (IST `HH:MM`, both or neither, `windowOf` in
`market.routes.ts`): only the trades entered from one minute to the other, both included, read in the order of the
expiry day -- 17:31 to 17:29 is the contract but its settlement minute, 19:00 to 18:00 is refused. Each day's
trades are kept by the minute they were entered in (`Cell.min`, 0 at 5:30 PM), so a window is a filter over what is
already held, never a new read.

`GET /api/market-report/breakdown?day=&account=&fromTime=&toTime=` -- that day's `signal` and `real`, each with `total`, `pairs`,
`byTf`, `byMethod`, `byStrategy`; in the window, the same way.

A day's trades are added up in memory and kept for a minute while the day can still change -- twelve hours past
its settlement for orders, four days for signals -- and for good after. Thirteen days read in about a second
cold and under a tenth of one after. While a new answer is on its way the old one is greyed and marked
(`Updating.tsx`).
