# 0011 — Two strategies may hold one contract; each trade keeps its own

**Status:** accepted and built, 30 September 2026 · paper-tested; the one-lot live test is open
([TODO.md](../TODO.md)) · **Replaces:** "one trade per contract", the engine's
unwritten rule until that day

## Context

On 26, 27 and 29 Sep two strategies -- `5-01-copy` at 15:55 and `5-01` at
17:01 -- chose the same strikes, and the second was refused:
`DUPLICATE_POSITION`, "Already holding -10 on this contract". Two different
strategies should both run, even on one strike, entered at different prices
with their own exits.

The gate was not the bug. The engine held **one trade per contract**:

- `syncPosition` read Delta's *net* position for the symbol and wrote it into
  the trade. Two trades of -10 would each have been rewritten to -20, and a
  close would have bought back both.
- `protect()` matched resting reduce-only orders by order *type* (limit =
  target, stop = stop), not by client id. Each trade would have edited or
  cancelled the other's target and stop as "wrong price".

Removing the gate alone would have corrupted both trades' books.

## Decision

Each trade's orders, fills and position are its own; Delta's position for a
contract is the sum of the trades on it.

1. **Orders.** `protect` and `clearProtection` leave alone any order another
   open trade on the contract owns (its client id carries that trade's seed).
   An order nobody owns -- placed by hand, or before client ids -- is still
   treated as this trade's, as before.
2. **Position.** `syncPosition` takes this trade's share as Delta's net minus
   the siblings' positions. It rewrites a trade only when that cannot be wrong:
   no siblings, or the contract flat. A gap it cannot attribute -- often just a
   sibling that has not absorbed its own fill yet -- is left alone, and said
   after `UNEXPLAINED_ALARM_MS` (60 s).
3. **The gate.** "Already holding" is about who asks: a strategy is refused only
   when it holds the contract itself (its `strategy_runs` claim already stops it
   entering twice a day); a manual ticket keeps the desk-wide rule.
4. **Ids.** Two orders in one millisecond get different trade ids
   (`nextTradeMs`); a repeated id is read as the first order re-sent.
5. **The screen.** A trade's P&L is sized from its own contracts, not Delta's
   row for the contract.

## Consequences

- Paper-tested in `test/trading/shared-contract.test.ts`: both protected, one
  target fills alone, one closed by hand, one stop reached, restart recovery, an
  unexplained gap, a contract closed by hand on Delta, the three gate cases.
- **Not yet known:** whether Delta holds two reduce-only targets and two stop
  triggers on one contract when they total more than the position -- it "will
  not hold two reduce-only orders totalling more than the position" for one
  trade's pair. That is a one-lot live test ([0002](0002-simulator-is-not-the-venue.md)).
- A shared contract's position is compared with Delta on reconcile, close and
  add, as a single trade's always was -- not on every poll.
- An *add* is still more of the same trade, not a second one.

**Where:** [engine.ts](../../app/server/src/trading/engine.ts) (`siblingsOn`,
`protect`, `syncPosition`, `runPrecheck`), [service.ts](../../app/server/src/trading/service.ts)
(`nextTradeMs`).
