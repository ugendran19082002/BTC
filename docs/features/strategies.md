# Scheduled strategies

A strategy is a saved order that places itself: at an IST time, on chosen
weekdays, it picks a strike by rule, sells it through the same gates as the
order ticket, and manages it to its own exit. The code is in
[`app/server/src/strategy/`](../../app/server/src/strategy/); the screen is the
**strategy** tab.

---

## One pass of the scheduler

Every 20 seconds (`TICK_MS`) [runner.ts](../../app/server/src/strategy/runner.ts)
looks at each strategy, if the desk-wide `scheduler_enabled` setting is on.
Switched off, it does nothing at all -- **scheduled exits included**; each
trade's own target and stop still work, because the engine holds those.

1. **Is an exit due?** At the strategy's own `exitTime` whatever it opened is
   closed. Deliberately not guarded like the entry: an exit missed at 17:29 is
   still wanted at 17:40.
2. **Is an entry due?** (`entryDue` in [schedule.ts](../../app/server/src/strategy/schedule.ts))
   Not if the strategy already ran for that slot's IST day, not on a weekday it
   is not set for, not more than `graceMin` (default 60) minutes after
   `entryTime`, and never at or after its own exit time. A missed window is
   reported once. (An entry time from 17:30 to 17:34 IST cannot be saved: it
   would land in Delta's launch auction for the new contract.)
3. **Read the whole board.** No live board: try again next pass, without
   spending the day. Nearest expiry not the daily contract: the day is marked
   `skipped`.
4. **Pick the legs** ([select.ts](../../app/server/src/strategy/select.ts)) --
   below. Nothing picked: `refused`, with the reason.
5. **Claim the day** -- `INSERT ... ON CONFLICT DO NOTHING` on
   `UNIQUE (strategy_id, run_date)` -- *before* any order goes out. Marked and
   not traded loses a day; traded and not marked doubles a position.
6. **Place each leg** through `TradingService.place`, the ticket's own path,
   gates included. One leg refused does not undo the other.
7. **Finish the day** as `placed` or `failed`, with one line per leg in
   `strategy_runs.detail`, and a phone alert if anything failed.

## Choosing the strike

| `strikeRule` | Takes | Out of the money only |
|---|---|---|
| `premium`, `atMost` | the richest strike paying at most `premium.usd` | yes |
| `premium`, `atLeast` | the furthest strike still paying at least `premium.usd` | yes |
| `strict` | the nth listed strike from the money (`strikeStep`: 0 ATM, +n OTM, −n ITM) | no -- naming the strike is the point |
| `oiWall` | the heaviest open interest within the desk's level band that still pays `premium.usd` | yes |

`premium.fallbackUsd` is a second number on the same rule, tried only when the
first finds nothing at all.

**Out of the money** means worth nothing if it expired now: a call above spot,
a put below it. The strike nearest spot is labelled ATM on both sides, and
until 30 Sep 2026 the premium rules skipped it even when it was a call just
above spot -- which sent the 17:01 strategy one strike further out than
AlgoTest every day (29 Sep: CE 84,400 at 0.80 against AlgoTest's 84,200 at
7.58). `outOfTheMoney()` now counts it when it sits on the out-of-the-money
side of spot; a strike exactly at spot is not out of the money on either side.

Prices are the **bid** (`sellPrice`), what a seller can expect to receive. The
run's journal line gives the offer beside it (`CE 84200 x10 @ 7.6, ask 8.1`), so
the spread every scheduled entry sold into is on the record.

**The minimum premium.** Whatever the rule picks must also pay the desk's $5
floor -- or the strategy's own, when "Its own minimum premium" is set
(`minPremiumUsd`, at least $0.10). A 99% target on a cheap leg is never under
one tick.

## Pricing the entry

| `entryPrice` | What happens |
|---|---|
| `offer` (default) | Rest at the ask, walk to the bid over `crossAfterSec`, but only while the spread is within `maxCrossSpreadPct`; wider, wait at the mid. Unfilled at the end of the entry window: cancelled. `crossAfterSec: 0` rests until filled. |
| `now` | Market order. Certain fill, pays the spread. |
| `set` | Rest at `entryLimit`. |

## Exits

Target and stop are each a percentage, points, or a price (`targetMode`,
`stopMode`), and can step over the day (`targetSteps`, `stopSteps`: from
`HH:MM` the level becomes that step's value). Which step is in force is a
function of the clock, not stored. `monitorOn` chooses whether the desk's stop
watch reads the live price (`ltp`) or waits for the minute to close (`close`);
the backstop at Delta triggers on the mark either way
([decision 0006](../decisions/0006-target-is-a-price-stop-is-an-exit.md)).
The stage a trade's exits are on is written on the trade (`plan.exitStage`), so
a restart carries on from it rather than applying it again over a leg moved by
hand.

Every position is a short, so **both exits are buy-backs**. The target rests at
Delta as a reduce-only buy limit, rounded up to the tick (towards filling) but
never to the entry; the stop is judged on the **offer** and closed at the
market. A slippage alert measures both the same way: paying more than asked is
against the desk. Both are re-read off the actual fill for a percentage or
points (a fill at 42 against a 39 limit moves a 185% stop to 119.7).

## Why a strategy is refused

Every refusal is a sentence in `strategy_runs.detail`. The common ones:

| Refusal | Source | Meaning |
|---|---|---|
| `nothing out of the money at or below $N` | the rule | The board had no strike the rule could take. |
| `This one pays X and the desk will not sell below 5.00` | `precheck` `PREMIUM_TOO_LOW` | The desk's premium floor, or the strategy's own (`minPremiumUsd`, "Its own minimum premium" on the form) when it sets one. Late in the day most strikes pay under $5. |
| `Already holding -N on this contract.` | `precheck` `DUPLICATE_POSITION` | This strategy already holds the contract. (Another strategy's trade on it does not count -- [decision 0011](../decisions/0011-one-trade-per-contract.md).) |
| `Spread is X%, limit is 15% for an order that crosses it.` | `precheck` | The book is too wide to cross. |
| `The stop is X over a fill at the B bid, inside the S spread` | `precheck` `STOP_INSIDE_SPREAD` | A stop no wider than the spread would be reached as the entry fills (the offer is already there) and bought back seconds later. Widen the stop or wait for a tighter book. Not checked when `monitorOn` is `close`. |
| `Would take total short to N, limit is M.` | `precheck` `MAX_POSITION` | The desk's `max_short_contracts` cap. |

To see a day's runs:

```sql
SELECT strategy_id, run_date, status, detail
  FROM strategy_runs ORDER BY id DESC LIMIT 20;
```

## Two strategies on one strike

Since 30 Sep 2026 two strategies may hold the same contract: each is its own
trade with its own orders, exits and P&L, and Delta's position is their sum
([decision 0011](../decisions/0011-one-trade-per-contract.md)). One strategy
still cannot enter a contract it already holds, and a manual ticket is still
refused on any contract the desk holds. Paper-tested; the one-lot live test is
open ([TODO.md](../TODO.md)).

## Known limits

- Whether Delta holds four reduce-only orders on one contract (two strategies'
  targets and stops) is not yet tested live.
