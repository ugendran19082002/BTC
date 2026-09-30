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
   reported once.
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

Prices are the **bid** (`sellPrice`), what a seller can expect to receive.

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

## Why a strategy is refused

Every refusal is a sentence in `strategy_runs.detail`. The common ones:

| Refusal | Source | Meaning |
|---|---|---|
| `nothing out of the money at or below $N` | the rule | The board had no strike the rule could take. |
| `This one pays X and the desk will not sell below 5.00` | `precheck` `PREMIUM_TOO_LOW` | The desk-wide premium floor. Late in the day most strikes pay less. |
| `Already holding -N on this contract.` | `precheck` `DUPLICATE_POSITION` | Another trade -- often another strategy -- holds the same contract. The engine holds one trade per contract ([decision 0011](../decisions/0011-one-trade-per-contract.md)). |
| `Spread is X%, limit is 15% for an order that crosses it.` | `precheck` | The book is too wide to cross. |
| `Would take total short to N, limit is M.` | `precheck` `MAX_POSITION` | The desk's `max_short_contracts` cap. |

To see a day's runs:

```sql
SELECT strategy_id, run_date, status, detail
  FROM strategy_runs ORDER BY id DESC LIMIT 20;
```

## Known limits

- Two strategies cannot hold the same contract at once
  ([decision 0011](../decisions/0011-one-trade-per-contract.md)).
- A 17:01 entry mostly finds premiums under the $5 floor. Whether a strategy
  may set its own floor is open ([TODO.md](../TODO.md)).
- An entry between 17:30 and 17:35 IST lands in Delta's launch auction.
- A 99% target on a cheap leg can round to zero ([TODO.md](../TODO.md)).
