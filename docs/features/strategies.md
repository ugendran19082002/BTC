# Scheduled strategies

A strategy is a saved order that places itself: at an IST time, on chosen
weekdays, it picks a strike by rule, sells it through the same gates as the
order ticket, and manages it to its own exit. The code is in
[`app/server/src/strategy/`](../../app/server/src/strategy/); the screen is the
**strategy** tab.

---

## A strategy belongs to one broker account

A strategy is made on an account's tab (Strategy screen) and belongs to that
account (`strategies.broker_account_id`); it cannot be made on "All accounts"
and never changes account. **Every account that is switched on trades its own
strategies at the same time as the others**, each on a desk of its own -- its
own exchange key, engine, balance and limits (`trading/service.ts`). So the
SELL account's strategies and the BUY account's take the same signal in the
same minute, each on its own account. A strategy whose account is switched off
does not enter, and its row says "not entering: its account is switched off".
The default account is only the tab that opens first.

## Groups of strategies

Owner, 10 Oct 2026: "account 1's in one group, account 2's in another; clone
and update". The Strategy screen lists the strategies **by group**, each group
with its strategies under it, then any in no group. A group is a way of listing
and switching an account's strategies together -- **not a switch of its own**:
the scheduler and the runner read each strategy's own switch, as before, and
never look at groups.

- **One account's.** A group belongs to one broker account
  (`strategy_groups.broker_account_id`) and holds only that account's
  strategies; an account may have any number of groups. A group's name is its
  own within its account (40 characters at most).
- **First start** (migration `strategy-010-groups`): each account with
  strategies gets a group named after it (`group-<account id>`), holding all of
  them. Nothing else changes: switches, live orders and settings stay as they
  were. A strategy with no account stays in no group.
- **Turn all on / off** sets each strategy's own switch. On takes two taps and
  says how many will have live orders; each strategy is checked as its own
  switch checks it, and one that does not pass is left off and named. Off is one
  tap; open trades keep their exits.
- **Clone** makes a new group with a copy of every strategy -- on the same
  account (names with " copy") or on another (names kept) -- **every copy
  switched off, live orders off**. The source is not touched.
- **Move**: a strategy's card has a Group picker of its own account's groups;
  moving to another account's group is refused (clone instead). A new strategy
  is made in the group it was started from (the account's first, from the
  header button).
- **Delete group**: an empty group goes on a second tap. One with strategies
  asks what becomes of them: the group alone (they stay, as they were, in no
  group), or the group and all of them -- a second tap, one transaction, and
  only with every one switched off. Those in no group can be moved into a
  group of their account together, or removed together, on the same terms.
- **Copy strategies** (header, a group's copy-in button, or a strategy's "To
  group"): pick any strategies, of any account and group -- by account, then
  group, with a search and "Pick all" -- and copy them into a group that exists
  or a new one, on any account. One transaction, all or nothing; every copy
  switched off, live orders off; a name the account already has gets " copy"
  (" copy 2", ...).
- **Group tag**: wherever a strategy's name is shown -- desk Positions, Orders
  and Trade history; the phone's Positions, Orders, History, a trade, and the
  Strategies screen -- its group's name sits beside it, read from the small
  `GET /api/strategy-groups/index` once for the page.
- **Display order**: a group's Reorder button lists its strategies as short
  rows -- dragged by their grip, or moved with up/down buttons -- saved as the
  whole list; the group moves up or
  down among its account's. `strategies.position` / `strategy_groups.position`
  (migration `strategy-011-display-order`), display only: the runner reads the
  strategies in its own order (`all()`, oldest first), so which takes a signal
  first is unchanged.
- The phone's Strategies screen lists them by group too, read only.

API: `POST /api/strategy-groups` (make), `POST /api/strategy-groups/:id`
(rename), `POST /api/strategy-groups/:id/enabled`, `POST
/api/strategy-groups/:id/clone`, `DELETE /api/strategy-groups/:id`, `POST
/api/strategies/:id/group`, `POST /api/strategy-groups/copy-in`,
`POST /api/strategy-groups/:id/order`, `POST /api/strategy-groups/order`,
`GET /api/strategy-groups/index`, `DELETE /api/strategy-groups/:id?strategies=delete`,
`POST /api/strategies/delete-many`, `POST /api/strategy-groups/:id/take`;
`GET /api/strategies` carries `groups`. Writes need
a full session.

## Each side its own limit under "At most open"

Owner, 12 Oct 2026: "CE max 80% and PE max 80%, each on its own -- not a split
that adds up to 100; the total still held to the max open"; "default 80%,
independent". That day Savings' 60 open trades were 8 calls and 52 puts: a run
of signals one way had filled the desk with one side.

Two numbers beside the account's "At most open", one for calls and one for
puts: the most of the cap that side may hold, **in whole per cent, each
independent of the other** (`signal_ce_max_pct`, `signal_pe_max_pct`, kept per
account as the cap is). **80 and 80 where none is chosen.** `sideCaps` gives
each side its trades -- its per cent of the cap to the nearest trade, at least
one where the per cent is above nothing. After the cap itself, the runner
holds the signal's side to its own limit, counted in **open trades**
(positions and working orders, whoever opened them): a side at its limit
skips the signal, in words, though the desk has room -- and the other side is
not touched. The cap still holds the two together: 80 and 80 is a full desk at
100, never 160. The limits are of the cap as it stands -- change the cap and
both follow; with no cap there is nothing to take a per cent of. 100 is no
limit of a side's own. A trade already open is never closed by a limit; a side
over its limit takes no new signal until it is back under.

| Open now (cap 60, 80 / 80 = 48 each) | New CE | New PE |
|---|---|---|
| CE 0, PE 0 | taken | taken |
| CE 48, PE 0 | skipped | taken |
| CE 24, PE 24 | taken | taken |
| CE 30, PE 30 (the cap) | skipped | skipped |

Screen: beside "At most open", "CE max" and "PE max" -- 50 to 100 %, or Custom
-- each with what that side holds of its limit, a full side said so. The
phone's Strategies screen has an "Open limits" panel, read only: bars for all
open trades, CE and PE -- the chosen account's, or one block per account on
"All accounts".
`POST /api/strategies/side-max { side, pct | null, accountId }` (null: back to
80); `GET /api/strategies` carries `signalSideMaxPct` and `openBySide`.

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
| `delta` | the strike nearest the money whose delta, as a size, is at or under `delta.max` (0.01 to 0.50; a strike with no delta on the board is passed over) | yes |
| `distance` | the strike nearest the money at least `distance.pct` percent from BTC -- as it stands (`scale: "fixed"`), or times the square root of the hours left to the settlement (`scale: "time"`: 0.45 is 2.0% with 20 hours left, 0.6% with 2) | yes |

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

### Time steps on the trade's timeline

A strategy whose target or stop has time steps says so on each of its trades:
once, the day's steps ("Dynamic target on: 70% · 75% from 11:30 PM · 80% from
1:30 AM"), then each move as it lands ("Target moved to 75% · was 70% ·
buy-back 6 → 5"). These are `exit_step` events in the trade's journal, written
by the exit stepper (`strategy/exit-steps.ts`) and shown as "Time step" lines
in the phone's trade view. They are notes: nothing about the trade changes.
A strategy with a fixed target writes none.

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
| `Worst case $X exceeds the $Y left in today's loss budget.` | `precheck` `DAILY_LOSS_LIMIT` | The order's worst case is more than what is left of the account's loss budget for the day (05:30 IST to 05:30 IST, booked losses only). |
| `Today's loss budget is used up: $L lost against a budget of $B.` | `precheck` `DAILY_LOSS_LIMIT` | The day has already lost the whole budget, so every new order is refused. The budget is the account's own: half its balance until an amount is set, and it can be raised or switched off on the **Account** card (**Daily loss limit**: the switch, and **Change the amount**). The change holds from the next order. |

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
| Bought or sold | **BUY \| SELL** over the leg on Strike & lots (`signal.action`). **SELL**: a BUY signal sells the PE, a SELL the CE -- every strategy before 5 Oct 2026 (`strategy-009` wrote `sell` into each). **BUY**: a BUY signal buys the CE, a SELL the PE. With live orders on it is a real order: a limit buy at the offer, cancelled unfilled after 5 minutes, through the buyer's gate (premium plus fee in the free balance, never on a contract held short), closed with a sale. Its option target and stop are judged by the desk on the bid (nothing rests at Delta for a long), and cannot step over the day. Off, each signal is written down as "would buy …". |
| Option TP / SL, sold and bought | Both sides have both, off at 0. **Sold**: the target is a buy-back *under* the entry, up to 99% of the credit; the stop a buy-back *over* it, up to 2000%. **Bought**: the stop is a sale *under* the entry, up to 99% -- the premium and no more -- and the target a sale *over* it, up to 2000%. One rule, `exitValueProblem(leg, mode, value, bought)`, on the server and in the form. Switching a strategy between BUY and SELL starts both at 0 rather than carry a seller's number into a buyer's meaning; a bought strategy's line reads "would buy CE 86200 x1 @ 18.5 · option TGT 74 · option SL 11.1 · perp SL · TGT". |
| Leg | from the signal. Sold: **BUY sells the PE**, **SELL sells the CE**. Bought: **BUY buys the CE**, **SELL buys the PE** (`legOfSignal`). `legs` is not read. |
| Which signals | the **Signals** tab: with the timeframe chain, or without it on any of 3m / 5m / 15m / 30m / 1h / 2h / 4h (several at once, `tfs`; 2h since 6 Oct 2026), and the methods, picked from the 81 with each one's record so far (win rate, trades, net points; "Pick profitable so far" = net above zero over at least 5 trades). The list narrows by family, by record (All / Profit / Loss / No trades) and, under that, by **Order side** (Both / Buy / Sell -- the method's mark in `entry_methods.order_side`, shown on each row); each row of chips counts what the others leave. |
| Strike | by premium (at least / at most, with a fallback), by strike (ATM ± n), by delta or by distance from BTC (8 Oct 2026) -- for the whole window or for a block of it. **By delta**: one number, with 0.05 / 0.07 / 0.10 / 0.15 a tap away. **By distance**: a percentage that either shrinks with the time left or is fixed all day, and under it what that comes to -- in percent, and in points where BTC's price is known; on a block, over that block's own hours. By distance has no else strike or "if none"; **by delta** may keep a distance and an else of its own (below); the minimum premium still applies. The run's line says what the rule read: "(delta 0.09)", "(2.12% from BTC, rule 2.01%)". |
| Premium rule | **≥ Greater or equal** (`atLeast`: the furthest strike still paying the number) or **≤ Less or equal** (`atMost`: the richest strike at or under it), with an optional "if none" number tried when the first finds no strike (`fallbackUsd`). |
| Distance rule and else strike | off by default, on any premium rule -- the strategy's own or a block's (**Keep it at least this far out of the money**; clock strategies too) -- and, from 18 Oct 2026, on any **delta** rule the same way (`delta.minOtm`, `delta.elseOtm`; the row then says "the delta's strike …"; delta by volatility keeps it under each level's number). Two strikes, each picked like a by-strike rule, OTM 1 to 20: the **rule** (`premium.minOtm`) and the **else** (`premium.elseOtm`), equal or different. The premium picks as always; a pick at the rule's strike or further out stands (OTM 7 under "at least OTM 6" is sold as OTM 7). A pick nearer the money, or no pick, is the rule failing: the else strike is sold, and the row says so -- "(rule failed: the premium's strike 84400 @ 51 is nearer than OTM 6 — went to the else strike OTM 8)". Else strike not listed with a price: the signal is refused, both halves said. What the else strike pays is still judged by the minimum premium. `elseOtm` absent reads as `minOtm`. |
| Same rule, or by time of day | two tick boxes on Strike & lots, one always ticked, each with its own section. **Same strike rule all the time** (the default): one rule for the whole window. **Different strike rule by time of day**: the window is cut into blocks -- every 4 hours unless another length is typed, so 5:35 PM to 5:29 PM is 4, 4, 4, 4, 4 and 3 h 54 min -- and each block has its own whole rule (premium, "if none", distance rule and else strike, or by strike). Block 1 starts with the window and is the strategy's own rule; the rest are `strikeBlocks: [{ at: "HH:MM", strikeRule, strikeStep, premium }]`, each from its time until the next (`strikePickAt`, read like `targetSteps`). A signal is sold under the block the clock is in when its order is sent, and its row says which ("· block 2, from 9:35 PM"). A block must start after the entry, before the exit and after the block before it. |
| SL distance | without the chain, a number of BTC points per timeframe picked (`signal.minSlPts`, e.g. `{ "5m": 150, "15m": 300 }`; Signals tab, **Take a signal only if its SL is far enough**). A signal is taken only if the distance from the perp entry to its SL is greater than or equal to its timeframe's number -- the entry being the fill at the zone, else the perp's last trade, else the middle of the signal's zone. Nearer, it is written down as `skipped`: "SL too near: the perp entry 84975 to the SL 84600 is 375 pts — this strategy takes 5m signals only at 500 pts or more". 0 or absent: no filter. Not read with the chain. |
| TGT distance | the same filter on the other side (`signal.minTgtPts`), beside the SL's on the Signals tab: per timeframe, the least distance from the perp entry to the target the trade exits at -- the rule's target, TGT1 where the signal has no TGT2 / TGT3. Nearer, the signal is `skipped`: "TGT too near: the perp entry 84975 to the TGT 85500 is 525 pts — this strategy takes 5m signals only at 600 pts or more". Each is its own condition, on from any number above 0; with both on and both failing the row says both. |
| SL / TGT maximum | the other end of both filters (`signal.maxSlPts`, `signal.maxTgtPts`, since 5 Oct 2026), a second field beside each on the Signals tab (≥ the minimum, ≤ the maximum): per timeframe, the most distance from the perp entry to the SL, and to the target. Further, the signal is `skipped`: "SL too far: the perp entry 84975 to the SL 84600 is 375 pts — this strategy takes 5m signals only at 300 pts or less". Exactly at the number is inside it. 0 or absent: no maximum, the default. A maximum under its own minimum is refused when saving -- no signal could pass both. Not read with the chain. |
| SL / TGT range with the chain | since 6 Oct 2026 a strategy with the timeframe chain has the same four numbers, one row on the Signals tab (**Chain**), kept under `chain` in each map (`signal.minSlPts.chain`, `maxSlPts.chain`, `minTgtPts.chain`, `maxTgtPts.chain`). They are the chain's own: a timeframe's number (`"5m": 100`) is never read with the chain, so a strategy copied from one without the chain, or switched to the chain, brings no filter with it -- it is off until set. A skipped signal says "this strategy takes timeframe-chain signals only at 400 pts or more". |
| Minimum premium | **Its own minimum premium**, last on Strike & lots: a gate on whatever the rules above picked. |
| Lots | per signal; **1** on a new signal strategy. |
| Entry price | at the offer, then at the bid after N seconds (5 by default) if the spread allows, or at the bid now; the entry is cancelled if still unfilled 5 minutes after the signal (`SIGNAL_ENTRY_MS`). |
| SL / TGT | **the signal's own levels on the BTC perpetual**, made per signal by its method: SL = the structure ± 0.25 ATR, TGT = TGT1, or TGT2 / TGT3 where the signal has them (else TGT1). Carried on the trade as `plan.underlying`. |
| Backstop | the option's own target and stop (the form's take profit / stop loss), resting at Delta as for any strategy: they still work when the desk cannot see the perp. |
| Skip perp SL / TGT | **Entry & exit → Exits on the BTC perp** (18 Oct 2026), a strategy that sells: **Skip perp SL** and **Skip perp TGT**, each off to begin with (`signal.skipPerpSl`, `signal.skipPerpTgt`; only `true` is kept). A level skipped goes to the order as none (`underlying.stop` / `target` null): the engine and the fast watch judge only the other, and the option's own stop and target resting at Delta, and the exit time, close the trade. The SL skipped is refused without an option stop -- fixed, by the clock or by volatility ("With the perp SL skipped, the option stop is the only stop"), so a sold option is never left with nothing under it; a strategy that buys keeps both. A zone fill or a signal entered at once is skipped as over only on a level the strategy uses; a resting entry is withdrawn the same way. From the next trade: one already open keeps the levels it was placed with. The order line, the trade tag and the card say "skipped"; the backtest by the strategy replays it. |
| Enter | **In the trade** (default, `enterOn: 'zone'`): when the BTC perp trades into the signal's entry zone -- the paper log's fill, the moment the signal history says "in the trade" -- so a signal that never fills is never traded, and the strategy takes exactly the trades the record counts. Or **At the signal** (`'signal'`): the moment it is written. A fill is skipped when it is too late for its timeframe -- **5m 90 s, 15m 150 s, 30m 210 s, 1h 5 min, 2h 7.5 min, 4h 10 min** (`zoneFillFreshMs`; the row says "too late to enter (a 4h signal within 600s)") -- when it was already out at its SL/TGT1, or, since 13 Oct 2026, when the perp has since reached the signal's SL or its target ("already at the signal's SL 84600 -- over before it could be entered"). |
| At once, all strategies | one number over every strategy (**At most open**, left of Auto-trading on the Live screen's Signal Strategies card; the setting `signal_max_open`, 0 to 500, 0 = no limit, set by `POST /api/strategies/max-open`). A signal is not taken while the desk already holds that many open trades -- positions and working orders, of every strategy and the ticket -- and is written down as `skipped`: "the desk already has 6 open (positions and working orders, all strategies) -- at most 6 at once across all". Checked after the strategy's own limit, which still applies. It cannot be set above what the switched-on strategies allow between them (the sum of their own limits) -- a limit that can never bind is refused, with that sum -- and with none set the field shows that sum, the limit in force. Margin is one pool: five strategies each allowed ten add up past it, and the order that does not fit is refused at Delta. |
| The rule in force now, on the card | each strategy's row has a **Now** line: the block the clock is in ("Block 8 of 8 · 2:35 PM → 5:29 PM · 1 h 47 min left"), the rule a signal arriving this minute is sold under, and the block that follows -- or "Same rule all the time" with its rule, or that it is outside its window. The line above it names only the first block's rule. |
| Lots and at most open, on the card | each strategy's row carries its **Lots per signal** and **At most open** as fields: typed, saved on leaving the field or Enter, through the same save as the form (Edit still has both). Refused numbers are said in the form's words and put back. They apply from the next signal. |
| Added up, and in use | under the Signal Strategies header, three tiles. **Strategies allow**: the switched-on strategies' entries, lots and the margin with all of it open. **In use now**: what the desk holds for them. **Still to open**: what can still open from here at worst -- each strategy's room inside what the desk-wide limit leaves *and* what the desk's limit on lots short leaves (`shortCap` less `shortNow`; an entry past it is refused by the order gate, so it is not room), the largest lots first, priced at the dearer of the 200x model and what Delta is charging per lot on what is held -- and the margin that needs against what is *free*, in red with what to lower when it is more. Only what is still to open is held against the free balance: that balance is already net of the open positions' margin (until the afternoon of 4 Oct 2026 the whole requirement was held against it, which counted them twice). The margin *in use* is Delta's own figure where Delta gives it (`marginUsedUsd`); what is *still needed* is an estimate, and says its rate. The foot of the card says which build the server is (`BUILD_TAG`, the image tag) and since when. Each strategy's row says its own: **Open now** n of its limit, **Lots in use**, **Margin in use**, from what the desk holds for it (positions and working orders; `open` on each strategy in `GET /api/strategies`). |
| At once | at most 1-100 of its trades open (`maxOpen`, typed, quick picks 1/5/10/25/50/75/100); a signal past it is written down as skipped. With live orders off, the "would sell"s still in play in the paper log count; signals are taken one at a time **in each account**, so a minute's worth cannot all pass at once. |
| The line a signal waits in | since 13 Oct 2026 each account has its own line (`StrategyRunner.inTurn`): one account's orders do not wait on the other's. In a line the **longest timeframe goes first** -- 4h, 2h, 1h, 30m, 15m, 5m -- and on the same timeframe whichever came first, so when many signals come at once (9:30 PM, when every timeframe's candle closes together) it is a 5m signal that waits, not a 4h one. A strategy switched off, or the desk disarmed, while a signal waited is not traded. |
| Window | `entryTime` to `exitTime` is when it takes signals; whatever is open closes at `exitTime`. |
| No-entry window | since 9 Oct 2026, on the **When** tab under the two times: a switch, off by default, and up to six windows of **No entry from** / **Until** (`noEntry: { on, windows: [{ from, to }] }`). Inside one, no new entry: a signal is claimed and written down as `skipped` -- "inside the no-entry window 4:48 PM – 5:13 PM — no new entry until 5:13 PM" -- at the moment it would have entered (the zone's fill for one entering there), so it is not taken after the window either. **Nothing open is closed**: a trade taken before keeps its SL, TGT and exit time. From the until time signals are taken again (from is in the window, until is not; a window may run past midnight). Each window must lie wholly inside the strategy's own `entryTime` – `exitTime` -- a window partly outside is refused, not half-applied -- must not cover all of it, and must not overlap another; the pickers offer only those times, and the server refuses the rest in the same words (`noEntryProblems`). Switched off, the times are kept. A clock strategy has none: it enters once, at its own time. While one is in force the strategy's line says "no new entry until 5:13 PM (no-entry window 4:48 PM – 5:13 PM) -- what is open keeps its exits". |
| **Live orders** | **off by default** ([decision 0013](../decisions/0013-entry-setups-measured-before-trusted.md)): each signal is written down as the order it would have been ("would sell PE 84000 x1 @ 18 · perp SL 84600 · TGT 85500") and nothing is sent. On, it places the order. The switch sits in the form's footer on every tab, and on each row of Signal Strategies (turning it on takes a second tap); the list marks the row LIVE ORDERS. |

**The method list's profit and loss is the option's, not the perp's** (13 Oct 2026: "in the strategy form the
signal filter's profit and loss must be by the option's TGT and SL, not the perp's -- now it is the perp's"). The
**Profit / Loss / No trades** chips, the win-rate filter, **Pick profitable** and the figures beside each method
read each method's record as options, in rupees after charges, since 1 Oct. **Profit and loss by** chooses whose:

- **As options · Backtest** (what the form opens on): the same list as the Backtest screen's Method filter -- the
  Backtest's settings as last left in this browser, on the form's way and timeframes
  (`useOptionRecord` -> `GET /api/signal-backtest`). The owner works a strategy out on the Backtest screen and
  comes to the form to tick the methods it found, so the two must show one list ("the backtest's profit and loss
  list is right and the strategy form's does not match it", asked twice the same evening).
- **As options · this strategy's rules**: each method sold as the strategy *as saved* would sell it -- its strike
  rule at each hour, its lots, its hours, its SL and TGT distances -- and bought back at its option TGT or SL, or
  when the perp reaches the signal's SL or TGT; every method on all its signals, "at most open" left out
  (`POST /api/signal-backtest/methods { config }`, asked again 0.4 s after a rule changes, not when a method is
  ticked).
- **Perp points**: the old record (the Methods tab's: the signal's own trade to its SL or TGT); also what is
  shown for a strategy that buys, or while no record as options can be had -- the line under the switch says why.

**Keeping the pick and the list the same** ("the backtest's methods do not match the signal strategy's"). With
the settings alike the three lists are one -- checked on a copy of the data for all eight strategies -- and what
drifts is the *ticks*: the in-profit list moves with every new signal and every setting changed, and a pick stays
as it was made (the owner's saved "1h time" backtest had 37 ticked, his strategy 40, and the list was 41 by then).
So the form says how the pick stands against the list shown -- how many of the ticked are in profit, in loss and
without a trade, and the ones in profit left out, by name -- and has **Pick only these (N)**, which makes the pick
exactly the list shown (the Backtest's "Only the N in profit"), and **Copy methods from a saved backtest…**, which
takes the methods ticked in one. Both can be undone. The form's Backtest list reads the Backtest's own Method
list figures (`choices.methods`, with no limit on open trades), so it is that list to the rupee.

Both counts as options are said in a line, and under it **each setting of the strategy that is not the
Backtest's, by name** (`rulesApart`): the strike and its blocks by time, the option's target and stop and their
time steps, the SL and TGT distances on the form's timeframes, the perp target, the least premium, the hours, the
days. With none the line says the two are one list. (Lots are not named: they change the money, not which methods
are in profit.) "I changed every strategy to delta and it still does not match" (13 Oct 2026): all eight had the
Backtest's delta, lots, target and stop by then, and still a target by the clock (70% → 97% in nine steps, the
Backtest's fixed at 70%) and nearer distances (100 to 200 points for the Backtest's 250). With those two made the
same on a copy of that evening's data, every strategy's list matched its saved backtest to the trade and the
rupee. That evening "4h time" was saved as premium ≤ $50 with strike blocks, 16 lots, TGT 90%, SL +300%, SL
and TGT ≥ 150 points, and the owner's saved backtest of the same name was delta ≤ 0.10, 2 lots, TGT 70%, SL
+160%, SL and TGT ≥ 250 -- 31 in profit and 8 in loss by the first, 34 and 6 by the second.
Checked on the 22 saved strategies against a separate working-out: every method's trades, wins and money agree.


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

## Delta by volatility (17 Oct 2026)

A signal strategy that sells by delta may set its delta by how volatile it is when each signal fills
([0018](../decisions/0018-delta-by-volatility.md)): **Strike & lots → Delta by volatility**, off to begin with. On, one
source — **ATM IV** (the at-the-money implied volatility against the same hour of the five expiry days before) or
**ATR 2h** (two hours of 15-minute candles against the five days before) — and the most delta at each level, **Low 0.18 ·
Normal 0.10 · High 0.08** to begin with. The runner reads the level at the signal (`volLevelNow`, the backtest's own
reading) and sells the nearest strike inside that level's delta; a level it cannot read keeps the strategy's own
delta. The signal's line in the history ends with what decided it: "· low volatility (ATM IV): Δ ≤ 0.18", or
"· volatility (ATM IV) unknown: its own Δ ≤ 0.10". The card says it beside the rule ("Δ by ATM IV: low 0.18 · normal
0.10 · high 0.08"). Refused on save for a strategy that buys, is not by delta, or has strike blocks. Stored in the
strategy's config (`signal.deltaByVol`); no table of its own.

## SL by volatility (17 Oct 2026)

The option SL by the same level ([0019](../decisions/0019-sl-by-volatility.md)): **Entry & exit → SL by volatility**,
off to begin with; **Low +250% · Normal +200% · High +150%** of the premium to begin with. With delta by volatility on
too, the two read **one source** -- one reading a signal sets both, and changing it in either changes it in both. The
level is decided at the signal and the trade is placed with that SL (`exitsNow`), so the desk's stop watch and the
backstop at Delta follow it to the exit; an unreadable level keeps the strategy's own SL. The signal's line ends
"· high volatility (ATM IV): Δ ≤ 0.08, SL +150%"; the card carries "SL by ATM IV: low +250% · normal +200% · high
+150%" beside the delta's, in the window and out of it. Refused on save for an SL in points or as a price, an SL with
time steps, a strategy that buys, or a source other than the delta's. Stored in the strategy's config
(`signal.slByVol`).

## Known limits

- Whether Delta holds four reduce-only orders on one contract (two strategies'
  targets and stops) is not yet tested live.
- Signal strategies are paper-tested end to end (`test/e2e/signal-strategy.test.ts`);
  no real order has been placed by one. The perp SL / TGT is watched by the
  desk, so it acts only while the desk is up; the option backstop at Delta is
  what holds when it is not.
