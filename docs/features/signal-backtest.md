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
| Which signals | 9:30 PM → 3:59 PM IST, as the strategies trade (`desk`); or the whole expiry day (`all`) | desk |
| Strike rule | **by delta**: the nearest to the money with a delta of at most 0.05 / 0.10 / 0.15 / 0.20; **by premium**: the dearest priced at most $25 / $50 / $75 / $100 | delta 0.10 |
| Option stop | +100%, +150%, +300% over the premium sold, or none | +300% |
| Option target | 70%, 80%, 90% of the premium kept, or none | 90% |
| Lots a signal | 1, 10, 16 | 10 |

Each of the strike limit, option target, option stop and lots has a **Custom** choice: typed in the row's own
unit (a stop of +200% is typed as 200), checked against the same limits the server holds it to, applied on Use
or Enter, and shown on the chip after ("Custom · +200%").

**Strategy** beside **Method**: tick one or more of your current strategies and their methods and time frames are
ticked for the settings above -- a shortcut for those two filters, said in a line under them. Changing a method
or a time frame by hand ends it. (To use a strategy's own strike, lots, exits and limits too, choose it under
**Backtest by**.)
| Time frame, method | as on the market report | all |

Always out of the money, and never for under $10 (`MIN_PREMIUM`), as the strategies' own floor.

## Backtest by a saved strategy

**Backtest by** at the top lists the signal strategies that sell, with their account. Chosen, the settings below it
go and the strategy's own rules are used (`planOfStrategy`): its methods and time frames, its days and hours, its
no-entry window, its nearest and furthest SL and TGT, the strike rule in force at each hour (blocks included,
picked by the runner's own `selectLegs` on the recorded board), its lots, its TGT1/2/3, the option's own target
and stop, and its "at most N open". Not in it: other strategies' trades, the desk-wide limit and margin, and the
order queue. What it cannot replay is said under the result (timed target or stop steps; a target or stop set
in points or as a price; a strike by open interest). Beside the result, **Backtest against its real orders**:
what the orders it really placed in the range made. A strategy deleted since it was chosen falls back to the
settings. `GET /api/signal-backtest?strategy=<id>`; every answer carries `strategies`, the list to choose from.

## What it is priced on, and what that makes it

- **The perp**: one-minute highs and lows (`trade_flow_1m`). A minute that holds both the stop and the target is
  taken as the stop.
- **The option**: the whole board **every five minutes** (`option_snapshots`), which is as often as the desk
  keeps it -- the one-minute board (`option_snapshots_1m`) is kept for six hours only. So a fill is priced on the
  reading nearest it (within five minutes), an exit on the first reading at or after it -- up to five minutes
  late -- and the option's own target and stop are seen only at a reading.
- **Every signal is taken**: no "at most N open", no margin, no order queue. The total is therefore not what an
  account would have made. What a trade of each kind made, and how often, is what it is for.

Not traded, and counted: outside the hours chosen; no board reading within five minutes; no strike inside the
rule worth $10; no price to exit at.

## What is on the screen

1. **Backtest result**: the net and what one trade made, trades, win rate, profit factor, what the same trades
   made on the perp, and how many signals were not traded and why.
2. **When the perp's SL was hit**: how many trades the perp's stop closed, on how many the option was a profit
   all the same, and what they made together -- beside the same for the perp's target.
3. **Closed by which exit** and **By time frame**: trades, share in profit, net and one trade's.
4. **Best / worst pairs as options**, each with its perp points.
5. **By kind of day** (trend family or market type) and **By expiry day**.

## The first read (1-13 Oct 2026, delta 0.10, 10 lots, +300% stop, desk hours, all time frames)

33,345 trades, −₹76,645, −₹2.30 a trade. The perp's SL closed 18,546 of them: the option was still a profit on
2,054 (11%), and together they lost ₹1,80,281. The perp's target closed 12,405: a profit on 66%. By time frame
a trade made −₹3.79 on 3m, −₹3.21 on 5m, −₹0.09 on 15m, +₹2.49 on 30m, +₹4.61 on 1h, +₹5.69 on 2h and +₹8.79 on
4h.

## The API

`GET /api/signal-backtest?from=&to=&rule=delta|premium&value=&lots=&tp=&sl=&window=desk|all&tf=&method=` --
`params`, `signals`, `skipped`, `total`, `days`, `pairs`, `byTf`, `byMethod`, `byPattern`, `byFamily`,
`choices`. Each count carries `exits`, and each exit how many of its trades made money (`wins`).

A range is worked out a day at a time and each day kept in memory by its settings: thirteen days take about
five seconds the first time and under a tenth of one after. A day still running is worked again after five
minutes.
