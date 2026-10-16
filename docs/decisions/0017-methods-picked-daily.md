# 0017 — A signal strategy's methods may be picked again every day by their record

**Status:** accepted and built, 16 October 2026 · **Stands with** [0016](0016-shared-contracts-again.md)

## Context

The live strategies' method lists were picked by hand from the Win filter and rewritten almost every day; the last
rewrite, on 15 Oct between 8 and 9 PM, used days that include the ones it was then judged on. A list picked knowing
the days it is tested on looks better than it can be.

Measured on a copy of the live data, 16 live strategies, 1 lot. 8–15 Oct, each day traded only the methods that
passed the filter on the days before it:

| Filter, re-picked | Net, 8 days | Worst day |
|---|---|---|
| Every method | +$1.05 | −$15.14 |
| Profit only, daily | +$3.1 to +$7.4 | −$5 to −$12 |
| Win ≥ 75%, daily, all days so far | +$9.88 | −$4.70 |
| Win ≥ 80%, daily, the day before | +$5.17 | −$0.39 |
| Any filter, once a week | +$3.7 to +$7.4 | worse than daily |

The same filters picked knowing the test days made $16 to $31: about half of a backtest's Win list does not survive
being picked from the past alone.

## Decision

1. **Off unless switched on, per strategy** (Signals tab → Auto-update methods). Off, the list is the owner's own.
2. **Once a day at the strategy's own IST time** (9:00 PM to begin with). The desk looks every minute and runs a
   strategy whose time has passed and which has not run since; after a restart it catches up the same evening.
3. **The record is the form's own** (as options, this strategy's rules: every method on all its signals, none
   taking another's place), over the last N finished expiry days (7 to begin with, 1 to 30). The day being traded
   is never one of them.
4. **Kept: won at least X% (75 to begin with) of at least M trades (3 to begin with)**, best net first. One of one is
   100%: the least trades keep a lucky one out.
5. **None passing keeps the list.** A failed record keeps it too. A strategy is never emptied by a bad week.
6. **Only new signals read the list.** A trade open on a dropped method keeps its exits.
7. **Every change is kept** (`strategy_method_updates`): the daily update, with the rule, the days, the lists before
   and after and every method's record, and a save from the form that changed the list. One Telegram message a run.

## Consequences

- The lists shrink: on 16 Oct, Win ≥ 75% over 7 days took "15m time" from 15 methods to 4 and "All Chain 5m" from 15
  to 1. Fewer trades, each from a method that has been winning lately.
- A run of the 16 strategies takes about 5 to 10 seconds on the backtest thread at the chosen time; a backtest asked
  for in that minute waits for it.
- A method needs recent trades to stay: one that fires rarely drops out and comes back.
- The 8 days measured include two whipsaw days; every filter lost on 12–15 Oct and the stricter ones lost less.
  Fifteen days of history is a short sample.
