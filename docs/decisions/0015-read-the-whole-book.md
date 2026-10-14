# 0015 — Read Delta's whole book; sweep the exits no trade wants

**Status:** accepted and built, 14 October 2026 · **Extends:** [0001](0001-read-the-exchange.md),
[0002](0002-simulator-is-not-the-venue.md), [0014](0014-one-signal-trade-per-contract.md)

## Context

Delta mailed at 09:03 IST: "Your BUY Stop Loss Limit Order for 1 C-BTC-84200-141026 contracts was triggered ... This
order was immediately cancelled because it was marked as reduce-only." The desk had closed all twenty of that
contract's trades by 06:10.

The journal showed how a stop outlived its trade. At 06:03 one trade's record went from stop `…S0` to `…S1` with no
cancel of S0 in between; at the close only S1 was cancelled. `protect()` had read the book, not found S0, and placed
S1 beside it.

It did not find S0 because the desk did not read the book. `getOpenOrders` asked `GET /v2/orders` with
`product_symbol` and `page_size=100`. Delta's API reference lists no `product_symbol` for that endpoint -- its filter
is `product_ids` (up to ten) -- and its lists page by cursor ("each response metadata contains a before and after
cursor"). The answer was the account's first hundred open orders. At 06:03 there were 77 trades open, a stop and a
target each: about 150 orders, a third of them past the page. A trade whose stop was among them read as having
none.

Each second stop also took a share of its contract's reduce-only room, which Delta keeps to the position. That fed
the `no_position_left_for_reduce_only` target cancels of [0014](0014-one-signal-trade-per-contract.md), and the
stops themselves fired on the next trade's position or, as here, on none.

A restart at 10:30 then forgot the four target holds 0014 had set (they were kept in memory), and all four targets
went straight back on and were cancelled again.

## Decision

1. **The book is read whole.** `getOpenOrders` asks by `product_ids` (the contract's id from its product) and
   follows the `after` cursor until it is null. Past ten pages, or with a cursor that does not move, it does not
   answer: it throws, as an outage does, and every caller already reads a throw as "could not ask". The filter is
   still applied on our side as well. `getOrderByClientId` searches the contract's whole open book, not the
   account's first page.
2. **Leftover exits are swept.** Once a minute (`ORPHAN_SWEEP_MS`) the account's whole book is read. A
   reduce-only stop or target whose client id names a trade in this account's journal is cancelled, and the cancel
   verified, when that trade is finished or carries a different exit for that leg. The cancel is made under the
   trade's lock and noted on its timeline (`exit_step`, kind `swept`). Never swept: an order placed by hand (no client
   id of ours), one younger than thirty seconds, anything when the book could not be read whole.
3. **A target's hold is journaled** (`exit_step`, kind `held`, with `until`; null for the rest of the trade), so a
   restart keeps it. While held, the target is not "missing", so the trade is not sent to `protect()` -- and to
   Delta -- every second.
4. **A filled entry is not asked after again.** Once all of an entry has filled, the poll stops looking it up: one
   order read per open trade per second, to change nothing.

## Consequences

- One or two more reads a minute for the sweep (weight 3 each) against 20,000 units per five minutes; fewer reads
  overall, since held targets and filled entries no longer cost a read every pass.
- Delta's own cancel of an exit is shown on the trade's timeline as Delta's, with its reason, not as the desk tidying
  up.
- `PaperExchange` filters correctly and has no pages, so it could not have caught this. The tests stub Delta's
  transport with pages, a cursor and a whole-account answer.
