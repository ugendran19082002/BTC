# The backtest: the signal history sold as options

Since 13 Oct 2026. "Can the signal history be backtested on the past contracts' market price? Keep the perp's
TGT and SL. I ask because when the perp's SL is hit the contract has often decayed by then, and the trade is a
profit."

Where: the phone, **More → Backtest**; the desk, its own **Backtest** menu. One component (`app/web/src/components/report/SignalBacktest.tsx`), one route
(`GET /api/signal-backtest`), read-only. The work is `app/server/src/report/signal-backtest.ts`.

## What it does

For every signal that went "in the trade" (`entry_setups` with a fill), in the expiry day of its fill
([what an expiry day is](market-report.md)):

1. **Sell** an option at the fill: the **put on a BUY**, the **call on a SELL**, of the contract that settles
   at the end of that expiry day, at the strike the rule picks from the board as it stood -- at its **bid**.
2. **Buy it back** at the **offer** at the first of:
   - the perp reaching the signal's **stop** or its **TGT1** (`perp-sl`, `perp-tgt`);
   - the option's own **target** (90% of the premium kept: a resting buy, filled at its price) or its own
     **stop** (`option-tgt`, `option-sl`);
   - the end of the window (`window-end`).
3. Take the desk's charges on both fills (`fillChargesUsd`).

## The settings

| Setting | Choices | Default |
|---|---|---|
| Expiry days | since 1 Oct, the last 7, the last 30 | since 1 Oct |
| Which signals | 9:30 PM → 3:59 PM IST, as the strategies trade (`desk`); the whole expiry day (`all`); or **Custom** hours, a From and a To time IST that may run past midnight (`custom`, `?hfrom=&hto=`; the To minute not included; a trade still exits by its own SL, TGT or the expiry) | desk |
| Strike rule | **by delta**: the nearest to the money with a delta of at most 0.05 / 0.10 / 0.15 / 0.20; **by premium**: the dearest priced at most $25 / $50 / $75 / $100 | delta 0.10 |
| Option stop | +100%, +150%, +300% over the premium sold, or none | +300% |
| Option target | **Fixed**: 70%, 80%, 90% of the premium kept, or none. **Dynamic · by time**: a share to start with and time steps (IST) from which another share is in force, for every trade open then and every one sold after -- taken from a strategy that has such steps ("Target steps of"), or typed. Steps are read in clock order from 5:30 PM however they are typed. `?tp=&tsteps=23:30:73,01:30:76` | fixed 90% |
| Volatility when the signal fills | Off, Low, Medium, High: the last two hours of 15-minute candles at the fill against the mean 15-minute ATR of the five expiry days before -- under 0.8× is low, over 1.3× high (`volReader`). A signal whose level cannot be said (no five days before) is none of the three. `?vol=` | off |
| Lots a signal | 1, 10, 16 | 10 |
| Minimum premium | Off, $10, $15, $20 or Custom (0 to 500; typing 0 is off): a strike bid under it when the signal fills is not sold, and the signal is counted as "no strike". `?minprem=` | $10 |

Each of the strike limit, option target, option stop and lots has a **Custom** choice: typed in the row's own
unit (a stop of +200% is typed as 200), checked against the same limits the server holds it to, applied on Use
or Enter, and shown on the chip after ("Custom · +200%").

**Take a signal only if its SL and TGT are in range**, as in the strategy form: SL ≥ and ≤, TGT ≥ and ≤, BTC
points from the perp entry (the fill) to the signal's SL and to its TGT1; 0 is off, each bound its own condition,
one set for every time frame. A signal outside is skipped and counted ("with the SL or TGT outside the range
set"); a maximum under its minimum is refused. Typed and applied on leaving a field or on Enter. With **Backtest
by** a strategy, its own per-time-frame distances apply instead. `?slmin=&slmax=&tgtmin=&tgtmax=`.

**The desk's limits**, as on the Signal Strategies card: **At most open** across every trade (no limit, 20, 35,
58 or Custom, 0-500), and with it **CE max** and **PE max** as a per cent of it (50-100% or Custom), counted as
the desk rounds them -- 80% of 35 is 28 (`sideCaps`). Each trading account's limits as they stand are offered as
one tap ("Savings · 58 · CE 80% · PE 80%"). Checked in the runner's order: a strategy's own "at most open", then
the desk's, then the side's; what each skipped is counted. With a limit on, the time frame and method filters
choose which signals compete for the places (without one they only choose what is shown); the method list's
figures stay those of each method with no limit. They apply under **Backtest by** a strategy as well, on top of
its own limit. `?max=&ce=&pe=`; every answer carries `deskLimits`.

**Strategy** beside **Method**: tick one or more of your current strategies and their methods and time frames are
ticked for the settings above -- a shortcut for those two filters, said in a line under them. Changing a method
or a time frame by hand ends it. (To use a strategy's own strike, lots, exits and limits too, choose it under
**Backtest by**.)
| Time frame, method | as on the market report | all |

Always out of the money, and never for under the minimum premium -- $10 (`MIN_PREMIUM`, the strategies' own floor) unless another is set; with it off, anything with a bid.

## Backtest by a saved strategy

**Backtest by** at the top lists the signal strategies that sell, with their account. Chosen, the settings below it
go and the strategy's own rules are used (`planOfStrategy`): its methods and time frames, its days and hours, its
no-entry window, its nearest and furthest SL and TGT, the strike rule in force at each hour (blocks included,
picked by the runner's own `selectLegs` on the recorded board), its lots, its TGT1/2/3, the option's own target
and stop, and its "at most N open". Not in it: other strategies' trades, the desk-wide limit and margin, and the
order queue. Its timed target and stop steps are replayed, read forward from its entry time as the runner reads
them. What it cannot replay is said under the result (a target or stop set in points or as a price; a strike by
open interest). Beside the result, **Backtest against its real orders**:
what the orders it really placed in the range made. A strategy deleted since it was chosen falls back to the
settings. `GET /api/signal-backtest?strategy=<id>`; every answer carries `strategies`, the list to choose from.

## What it is priced on, and what that makes it

- **The perp**: one-minute highs and lows (`trade_flow_1m`). A minute that holds both the stop and the target is
  taken as the stop.
- **The option**: the whole board **a minute at a time** wherever there are one-minute prices (13 Oct 2026:
  "backtest on one-minute option prices; where the database has none, take them from Delta's API"), each expiry
  day from the best there is:
  1. **the desk's own one-minute record** (`option_snapshots_1m`: bid, offer, mark, delta of every strike), kept
     90 days from 13 Oct 2026 -- it was a rolling six hours before;
  2. before that, **Delta's own one-minute mark** of each contract (`option_marks_1m`, fetched once from
     `/history/candles?symbol=MARK:<contract>`, [market/option-marks.ts](../../app/server/src/market/option-marks.ts)),
     with the bid and the offer put as far from it as the desk's last five-minute reading of that contract had
     them (`minuteBoard`). Delta keeps no past bid or offer, so this is an **estimate**, and the screen says so.
     Checked on six hours where both exist (13 contracts, 2,459 minutes): the bid so estimated was $2.07 from the
     real one on average against $4.41 for the five-minute reading, the worst in a hundred $15 against $34;
  3. until a day's minutes have arrived, **the five-minute record** alone (`option_snapshots`).

  So a fill is priced on the reading nearest it and an exit on the first reading at or after it -- up to a minute
  late (five on a day still on the five-minute record) -- and the option's own target and stop are seen only at
  a reading. The result says how many days were priced on which, and each row of **By expiry day** carries it
  (`1m prices`, `1m est.`, `5m prices`; `priced` and each day's `grain` in the answer).
- **Delta's minutes are fetched in the background**, never by a backtest: a bounded run every five minutes (at
  most 150 unsigned requests, one at a time with a pause, none while the desk has used half its Delta quota),
  settled days only, only the contracts that could have been sold (out of the money, bid at $10 or more at some
  reading), each asked for once. Thirteen days were 504 contracts and 708,694 minutes, in three runs. A day's
  minutes are used only once every one of its contracts has been fetched -- half a board would pick other
  strikes -- and a day already worked on five-minute prices is worked again when they arrive.
- **Limits are yours to set**: with none, every signal is taken -- no "at most N open", no margin, no order
  queue -- and the total is not what an account would have made. What a trade of each kind made, and how often,
  is what it is for.

**Which exit is first** (checked 13 Oct 2026 on every trade of three sets of exits, 34,000 to 42,000 each, by
finding it again from the raw minutes: all agree). The perp is walked a minute at a time from the minute after
the fill; the option's readings before the perp's exit are looked at in order, and the first with the offer at
its target or its stop closes the trade there. A reading opens its minute, so in the minute the perp reaches its
level the option's own exit is first. Otherwise the trade is bought back at the offer of the first reading at or
after the perp's exit -- the same minute on a day a minute at a time -- unless that offer is already at or under
the option's own target: the buy resting there filled on the way down, at its own price, so the trade is the
target's and is not bought back for less than its own order stood at (38 to 458 trades, a few cents each, every
one of them in the backtest's favour before). Where the desk recorded a bid or an offer for the minute, that is
the price used (no exception found); only a minute with no recording is Delta's mark with the recorded spread.

Not traded, and counted: outside the hours chosen; SL or TGT outside the range; not in the volatility asked for;
over a limit on open trades; no board reading within five minutes; no strike inside the rule worth $10; no price
to exit at. The counts are of the time frames and methods chosen, as the tiles are: signals = traded + not traded
under every filter.

## What is on the screen

1. **Backtest result**: the net and what one trade made, trades, win rate, profit factor, **a day on average**
   (over the expiry days that traded; the days in profit and the days in loss each on their own, with how many),
   what the same trades made on the perp, and how many signals were not traded and why.
2. **When the perp's SL was hit**: how many trades the perp's stop closed, on how many the option was a profit
   all the same, and what they made together -- beside the same for the perp's target.
3. **Closed by which exit** and **By time frame**: trades, share in profit, net and one trade's.
4. **By volatility when the signal filled** (low, medium, high), **By method** (in profit / in loss), and the
   best and worst pairs, each with its perp points.
5. **By kind of day** (trend family or market type) and **By expiry day**, each day with what it was priced on.

**One colour for what is chosen.** The Backtest and the Market report are built from the phone's parts, which
filled a choice -- a segment, a chip, a ticked row, the button that does the thing -- with green; on the desk,
beside yellow tabs and a yellow Save, that was a second theme on one screen, and green there is money ("use the
same theme colour"). The parts now ask for `--chosen` (`styles.css`): the accent on the desk, the phone's own
green on the phone (`:root[data-view='phone']`, set while the phone app is up).

**On a phone** (13 Oct 2026, "the By method section is too wide on the phone"): under 640px every table row folds
to two lines -- the name with the net beside it, trades and share won beneath (`FOLD`) -- the three money figures
are a list with the whole figure, not tiles that cut it to "−₹79,2…" (`Ledger`), the settings sections sit flat
in the panel and their controls keep to one line (`Segmented dense`), and a time step's field shows its whole
time. Nothing is wider than the screen from 320px up; from 1280px the settings are a column of their own beside
the result.

## Saved backtests, and portfolios

"Save a backtest's settings and run a saved one; several saved ones as a portfolio, with the total of them all"
(13 Oct 2026).

**One section at a time** ("a single backtest, or a portfolio run -- the portfolio section or the backtest
section, only one open at a time"). **What to run** at the top of the screen: **Single backtest** -- the settings,
the filters, the saved backtests to keep and put back, and one result -- or **Portfolio** -- the days, the
portfolios, the saved backtests as ticks, and what they come to together. Which is open, the last run together
and its limit are kept in the browser. ([SavedBacktests.tsx](../../app/web/src/components/report/SavedBacktests.tsx),
`mode`.)

**Under Single backtest**, the **Saved backtests** panel:

- **Save** keeps the settings on the screen under a name -- the strike rule, the exits, the hours, the limits,
  the filters, or the strategy it is worked by. Not the days and not the result: a saved backtest is run over
  whatever days the screen is on. The desk checks a saved one's settings as it checks the screen's.
- Each row says its settings in a line. **Tapping one** puts them back on the screen; the one whose settings are
  on the screen is marked. Changed since, it can be **updated** in place or saved as another. **×** asks once more.

**Under Portfolio:**

- **Tick two or more** (twelve at most) and **Run these together**: the total, a day on average, each one, each
  expiry day, and the margin -- the most held at once across all of them on one clock, with the sum of each one's
  own most beside it.
- **Which signals, for the run: As saved** (what it opens on) · **9:30 PM–3:59 PM** · **Whole day** · **Custom** --
  the single backtest's hours choice, over a run together (13 Oct 2026). Anything but As saved is put over every
  saved backtest in the run that is worked by settings, for the run only: nothing saved is changed, and the result
  says so over its total ("Signals of the whole expiry day (IST) for this run, in place of each saved backtest's own
  hours"). One worked by a strategy keeps that strategy's own days and hours, as it does alone, and is named.
  `?hours=saved|desk|all|custom&hfrom=&hto=`; the answer's `hours { window, hoursFrom?, hoursTo?, own[] }` (null as
  saved). Kept in this browser (`signalBacktest.together.hours`).
- **The limit on open trades: One account** (what it opens on) or **Each its own limit**. The desk's "at most
  open" and its CE and PE shares are an *account's*, not a strategy's. Seven saved backtests of "at most 120" each
  were first worked alone and added up, and the total said 152 open at once (179 a few hours later) -- more than
  the account would ever hold, and a margin worked from trades it would not have taken ("the portfolio's margin at
  most, together -- work it out correctly"). As **one account** they are traded on one clock, in the desk's own
  order -- as they filled, the longer time frame first -- for the same places (`simulateTogether`): the largest
  "at most open" among them, with its shares, for all of them; a signal that finds the account or its side full is
  counted as turned away and said. The limit is **on the screen and can be typed** ("show the at-most-open field
  with its default value, editable"): **At most open, together**, **CE max** and **PE max**, opening on the
  default -- **the account's own limit as it stands on the desk** (the trading account with the most room), and
  only without one the largest among the saved backtests run -- and taking another on leaving a field or Enter (1
  to 500, 1 to 100%); **Default** puts it back. Each trading account's limit and the saved backtests' own are
  offered as one tap above the fields. With no limit anywhere the fields are empty and none is shared until one is
  typed. (For an evening the default was the saved backtests' 120 while the account was set to 200 -- "one account"
  that was not the owner's, and a margin that looked wrong for it: ₹8,626 at 120 open, ₹13,581 at the account's
  200, of which 189 were ever needed.)
- **The margin's working is on the screen**, in both sections ("I think the margin amount is shown wrongly -- check
  every calculation"): how many trades and lots were open at its moment and what one lot holds -- BTC ÷ 200 ×
  0.001 at the desk's 200x, as Delta's ticket says under Funds req. -- so the figure can be multiplied out
  (`marginWorking`, `margin.peakLots`): "189 trades of 378 lots together × ₹35.93 a lot = ₹13,581". Worked out
  again from the trades for the owner's own portfolio: every figure the screen gives -- trades, net, charges, each
  member, each day, the margin, its moment and how many were open -- is the same; and the desk's real orders are
  placed at 200x. **Each its own limit** is the first way, and says that more may be open than one account holds.
  Checked on the owner's seven over 1-13 Oct: each on its own 3,627 trades, +₹6,833, ₹12,804 of margin with 179
  open; as one account 3,377 trades, +₹6,115, 250 signals turned away, ₹8,624 with 120 open -- never over 120, 96
  calls or 96 puts at any trade's start, nobody turned away while there was room, and no shorter time frame taken
  ahead of a longer one for the last place.
- **Edit** on a saved backtest puts its settings on the screen to be changed there, with its name beside them;
  **Edit** on a portfolio ticks its members in the list to be changed there, with its name. Nothing is kept until
  **Save changes** (the same one, under its id); **Cancel** leaves it as it was. A portfolio on the screen as a
  run follows its edit.
- The set can be **kept as a portfolio** under a name and run again in one tap. A portfolio holds its saved
  backtests by id, so one changed is changed in every portfolio it is in; one deleted leaves them, and a portfolio
  left with fewer than two goes with it -- said. A saved backtest whose strategy has since been deleted is listed
  in a run with why, and counts as nothing.

`backtest_saves` (id, name unique whatever its capitals, `query` as JSON) and `backtest_portfolios` (id, name,
`save_ids`), `report/backtest-saves.ts`; at most 100 and 30. `GET/POST /api/backtest-saves`,
`DELETE /api/backtest-saves/:id`, `POST /api/backtest-portfolios`, `DELETE /api/backtest-portfolios/:id`,
`GET /api/backtest-portfolio?ids=&from=&to=&limit=shared|own&max=&ce=&pe=&hours=saved|desk|all|custom&hfrom=&hto=` (worked in the backtest's thread,
`portfolioBacktest`; `shared` in the answer says the limit they were held to and how many it turned away). Checked on
1-12 Oct with two saved: each member is its own backtest to the cent, the total their sum, every day its members'
sum, the margin together ($1,583 with 374 open) between the larger one's own and the two added ($1,643).

## The first read (1-13 Oct 2026, delta 0.10, 10 lots, +300% stop, desk hours, all time frames)

33,345 trades, −₹76,645, −₹2.30 a trade. The perp's SL closed 18,546 of them: the option was still a profit on
2,054 (11%), and together they lost ₹1,80,281. The perp's target closed 12,405: a profit on 66%. By time frame
a trade made −₹3.79 on 3m, −₹3.21 on 5m, −₹0.09 on 15m, +₹2.49 on 30m, +₹4.61 on 1h, +₹5.69 on 2h and +₹8.79 on
4h.

## The API

`GET /api/signal-backtest?from=&to=&rule=delta|premium&value=&lots=&tp=&sl=&window=desk|all&tf=&method=` --
`params`, `signals`, `skipped`, `total`, `days`, `pairs`, `byTf`, `byMethod`, `byPattern`, `byFamily`,
`choices`. Each count carries `exits`, and each exit how many of its trades made money (`wins`).

`?window=custom&hfrom=&hto=`, `?max=&ce=&pe=`, `?slmin=&slmax=&tgtmin=&tgtmax=`, `?tsteps=`, `?vol=`,
`?strategy=` as above; the answer also carries `priced`, `byVol`, `margin`, `strategy`, `strategies`,
`deskLimits`.

**Worked in a thread of its own** ([report/backtest-run.ts](../../app/server/src/report/backtest-run.ts),
`backtest-worker.ts`; 13 Oct 2026). A fortnight a minute at a time is seconds of reading and arithmetic, and in
the desk's own thread it held everything else up for most of a second at a stretch -- the thread that looks at
every open trade's stop each second. In its own, the desk's slowest answer meanwhile was 0.2 s. The thread has
its own database connections, is started at the first backtest and kept, and never keeps the process alive; a
backtest that fails there is answered in words; where no thread can be started at all the backtest is worked in
the desk's own thread as before, and the error log says so. A test or a script (`signalBacktestHere`) works it
where it is asked.

The thread keeps each day as read -- signals, perp minutes and the board as columns of numbers (`prepareBoard`,
about 5 MB a day, 45 days at most) -- and each day worked under each set of settings (800 at most). Thirteen days:
about fifteen seconds the first time after a restart, about a second and a half for another set of settings, under
a fifth of one for the same again. The server asks the screen's own opening question three minutes after it
starts, so the first tap after a restart does not wait for the reading. A day still running is read again after
five minutes.

## While a new result is worked out

Changing any setting or filter shows a **Working out…** bar at once, and the result on the screen is greyed and
marked as the previous settings' until the new one arrives (`Updating.tsx`, `useAnswer`: the answer is kept with
the question it answers). The market report and its breakdowns do the same.

## Charges, and how the counts are kept honest

**Charges** are shown, not only taken off: the result has **Before charges**, **Charges** and **After charges**
(the net), with what charges come to a trade and as a share of the result before them; every row of the tables
carries its charges under its net. They are Delta's fee on each fill -- the lower of 0.01% of the BTC value and
3.5% of the premium -- plus 18% GST, on the sale and on the buy-back (`fillChargesUsd`, `BtTot.charges`).

**The counts** (checked on 13 Oct 2026 against the live data, every day from 4 to 13 Oct): every signal is either
traded or skipped for one reason, and the two add up to the signals; the signals inside the desk's hours match a
count straight from `entry_setups`; with a limit on, never more than that many are open, nor more than each side's
share. Signals that fill in the same second are taken in a fixed order -- the longer timeframe first, as the live
queue takes them (`signalOrder`) -- so a limit gives the same count every time; before, which of a tie took the
last place followed the database's row order (12 Oct came out 759 or 873). "Traded here" in the summary counts
every reason a signal was not traded, the limits on open trades included.

**Every filter and every figure, checked against a second working-out** (13 Oct 2026). A separate program, written
from the rules above and reading the tables itself -- nothing of the backtest's own code in it -- asked the API 47
questions over 1-12 Oct (each setting on its own: the hours and custom hours across midnight and across 5:30 PM,
both strike rules and custom values, lots, fixed and no target, four dynamic targets, the stop, the SL and TGT
range, four sets of limits, each volatility level, time frames, methods; then mixed) and compared every figure of
every answer: each day's trades, wins, net, charges, perp points and each exit; signals and each reason not
traded; every row by time frame, method, pair and volatility; the margin's peak, its moment and its averages. Over
a million trades. It found three faults, now fixed and each with a test:

- **target steps typed out of clock order** were read in the order typed -- 03:30 above 23:30 left 23:30's share
  in force all morning;
- **the time frame and method filters did not narrow the counts** -- "49,059 signals went in; 23,922 traded" beside
  a Trades tile of 8,171;
- **two strikes with the same bid** (common far out, under the premium rule): which was sold followed the
  database's row order. Now the nearer the money, as the desk walks the board.

Also: the fee on the buy-back is worked from BTC at the exit, not at the entry (it matters on the few fills where
the fee on notional is the smaller). All 47 agree on every figure, on five-minute and on one-minute prices. The
22 saved strategies were checked the same way against their own stored rules -- methods, time frames, hours,
no-entry windows, nearest SL and TGT, lots, strike rule, "at most open", the target by the clock, the perp's exit
and each trade's money.

The Strategy filter's search finds a strategy by its account's name too ("Savings", "Expenses").

## Margin

The result card shows the margin the trades shown would have held, by the desk's own estimate at 200x
(`fundsRequiredPerContract`, the same model as the Signal Strategies card's "margin with all of it open"): each
trade's at its entry premium and BTC, times its lots. **Margin at most** is the most held at once in the range
(a sweep over the trades' times, `peakMargin`; a trade ending as another starts has made room for it), with when
and how many trades were open then; **On that margin** is the result after charges over it; **A day's most,
average** is each expiry day's most, averaged. It follows the filters, as the rows do. Delta's own figure moves
with the premium and is often a little higher. `margin` in the answer.
