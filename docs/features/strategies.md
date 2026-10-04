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

## Signal strategies

Since 2 Oct 2026 a strategy can enter on a **signal** instead of a time: the
desk's entry methods ([entry-sl-tgt.md](entry-sl-tgt.md)), traded as a short
option. Made on the **Live** screen, in **Signal Strategies** right under the
Entry setups header card: **New signal strategy** opens a form of its own --
four tabs, **Signals / Strike & lots / Entry & exit / When**, and only what a
signal strategy has (no legs, no entry time, no late-entry window). The
Strategy tab lists them with the rest, and Edit there opens the same form. Both
strategy forms are built from one set of parts
(`app/web/src/components/strategy/form-parts.tsx`) and check and save the same
way (`useStrategyDraft`).

| | |
|---|---|
| Leg | from the signal: **BUY sells the PE**, **SELL sells the CE** (`legOfSignal`). `legs` is not read. |
| Which signals | the **Signals** tab: with the timeframe chain, or without it on any of 3m / 5m / 15m / 30m / 1h / 4h (several at once, `tfs`), and the methods, picked from the 81 with each one's record so far (win rate, trades, net points; "Pick profitable so far" = net above zero over at least 5 trades). |
| Strike | by premium (at least / at most, with a fallback) or by strike (ATM ± n), the same parts as every strategy. |
| Premium rule | **≥ Greater or equal** (`atLeast`: the furthest strike still paying the number) or **≤ Less or equal** (`atMost`: the richest strike at or under it), with an optional "if none" number tried when the first finds no strike (`fallbackUsd`). |
| Distance rule and else strike | off by default, on any premium rule -- the strategy's own or a block's (**Keep it at least this far out of the money**; clock strategies too). Two strikes, each picked like a by-strike rule, OTM 1 to 20: the **rule** (`premium.minOtm`) and the **else** (`premium.elseOtm`), equal or different. The premium picks as always; a pick at the rule's strike or further out stands (OTM 7 under "at least OTM 6" is sold as OTM 7). A pick nearer the money, or no pick, is the rule failing: the else strike is sold, and the row says so -- "(rule failed: the premium's strike 84400 @ 51 is nearer than OTM 6 — sold the else strike OTM 8)". Else strike not listed with a price: the signal is refused, both halves said. What the else strike pays is still judged by the minimum premium. `elseOtm` absent reads as `minOtm`. |
| Same rule, or by time of day | two tick boxes on Strike & lots, one always ticked, each with its own section. **Same strike rule all the time** (the default): one rule for the whole window. **Different strike rule by time of day**: the window is cut into blocks -- every 4 hours unless another length is typed, so 5:35 PM to 5:29 PM is 4, 4, 4, 4, 4 and 3 h 54 min -- and each block has its own whole rule (premium, "if none", distance rule and else strike, or by strike). Block 1 starts with the window and is the strategy's own rule; the rest are `strikeBlocks: [{ at: "HH:MM", strikeRule, strikeStep, premium }]`, each from its time until the next (`strikePickAt`, read like `targetSteps`). A signal is sold under the block the clock is in when its order is sent, and its row says which ("· block 2, from 9:35 PM"). A block must start after the entry, before the exit and after the block before it. |
| SL distance | without the chain, a number of BTC points per timeframe picked (`signal.minSlPts`, e.g. `{ "5m": 150, "15m": 300 }`; Signals tab, **Take a signal only if its SL is far enough**). A signal is taken only if the distance from the perp entry to its SL is greater than or equal to its timeframe's number -- the entry being the fill at the zone, else the perp's last trade, else the middle of the signal's zone. Nearer, it is written down as `skipped`: "SL too near: the perp entry 84975 to the SL 84600 is 375 pts — this strategy takes 5m signals only at 500 pts or more". 0 or absent: no filter. Not read with the chain. |
| Minimum premium | **Its own minimum premium**, last on Strike & lots: a gate on whatever the rules above picked. |
| Lots | per signal; **1** on a new signal strategy. |
| Entry price | at the offer, then at the bid after N seconds (5 by default) if the spread allows, or at the bid now; the entry is cancelled if still unfilled 5 minutes after the signal (`SIGNAL_ENTRY_MS`). |
| SL / TGT | **the signal's own levels on the BTC perpetual**, made per signal by its method: SL = the structure ± 0.25 ATR, TGT = TGT1, or TGT2 / TGT3 where the signal has them (else TGT1). Carried on the trade as `plan.underlying`. |
| Backstop | the option's own target and stop (the form's take profit / stop loss), resting at Delta as for any strategy: they still work when the desk cannot see the perp. |
| Enter | **In the trade** (default, `enterOn: 'zone'`): when the BTC perp trades into the signal's entry zone -- the paper log's fill, the moment the signal history says "in the trade" -- so a signal that never fills is never traded, and the strategy takes exactly the trades the record counts. Or **At the signal** (`'signal'`): the moment it is written. A fill reported more than 90 s late, or one already out at its SL/TGT1, is skipped. |
| At once | at most 1-100 of its trades open (`maxOpen`, typed, quick picks 1/5/10/25/50/75/100); a signal past it is written down as skipped. With live orders off, the "would sell"s still in play in the paper log count; signals are taken one at a time, so a minute's worth cannot all pass at once. |
| Window | `entryTime` to `exitTime` is when it takes signals; whatever is open closes at `exitTime`. |
| **Live orders** | **off by default** ([decision 0013](../decisions/0013-entry-setups-measured-before-trusted.md)): each signal is written down as the order it would have been ("would sell PE 84000 x1 @ 18 · perp SL 84600 · TGT 85500") and nothing is sent. On, it places the order. The switch sits in the form's footer on every tab, and on each row of Signal Strategies (turning it on takes a second tap); the list marks the row LIVE ORDERS. |

How a signal becomes an order (`StrategyRunner.onSignal`, `strategy/runner.ts`):

1. The entry recorder writes a new TRADE (3 s after each minute closes) and
   hands it to the runner at once -- the same moment Telegram is told.
2. Each enabled signal strategy whose way, timeframe and methods match, inside
   its window, with auto-trading on, **claims** the signal
   (`strategy_signal_runs`, unique on strategy and signal): a signal is taken
   once, whatever restarts or repeats.
3. Its open trades are counted against `maxOpen`; the board must be live and
   the daily expiry's.
4. The strike is picked by the strategy's rule for the signal's leg, and the
   order is placed with the perp SL and TGT on its plan -- or, with live
   orders off, written down as `would-place`.
5. The engine, every second, reads the perp's last trade (fresh within 15 s)
   and buys the option back the moment it reaches the SL or the TGT; a stale or
   missing price closes nothing and leaves the backstop at Delta.

**The points, exactly.** Each option fill of a signal trade records the BTC perp's last trade at that moment (`state.perpEntry` at the first entry fill, `state.perpExit` at the last exit fill), and the fill's time -- within the one-second poll, as close as Delta's order report allows. A trade from before these were kept shows the perp over the fill's minute (`trade_flow_1m` VWAP, else `index_1m` mark), marked ≈ on the screens; nothing in the journal is rewritten.

**On the screens.** Positions and Orders label a signal trade with its method, BUY/SELL and timeframe, and `perp entry → exit · SL · TGT`; Orders says why the desk closed it. The strategy's name is its current one (looked up by id), so a rename shows everywhere; a deleted strategy's trades keep the name they were placed under. **Telegram**: the fill and exit alerts carry the signal, the perp SL and TGT, the option exits as the backstop, the strategy's name, and why the desk closed it. **Trade history** (Signal Strategies, 10 a page; a trade the else strike sold says "rule failed: …" under its strike, with its block, and a signal not taken says why under Skipped): tabs All / Live orders / Would sell / Open / Won / Lost / Skipped, with counts; each trade's perp entry and option entry with their times, the perp SL and TGT with the exit time under whichever was hit, the perp exit and option exit, the result and the P&L.

What each signal did is under Signal Strategies on the Live screen and **Signals taken** on the Strategy tab; a trade closed at the end of the window adds "closed at 5:29 PM, the end of its window" to its signal's row:

```sql
SELECT strategy_id, method, mode, tf, dir, status, detail, at
  FROM strategy_signal_runs ORDER BY at DESC LIMIT 20;
```

## Known limits

- Whether Delta holds four reduce-only orders on one contract (two strategies'
  targets and stops) is not yet tested live.
- Signal strategies are paper-tested end to end (`test/e2e/signal-strategy.test.ts`);
  no real order has been placed by one. The perp SL / TGT is watched by the
  desk, so it acts only while the desk is up; the option backstop at Delta is
  what holds when it is not.
