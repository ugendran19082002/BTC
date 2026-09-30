# 0011 — One trade per contract, for now

**Status:** accepted as the current constraint; a change is proposed below and needs a go-ahead ·
**Since:** 30 September 2026 (written down; the constraint is older)

## Context

On 26, 27 and 29 Sep two strategies -- `5-01-copy` at 15:55 and `5-01` at
17:01 -- chose the same strikes, and the second was refused:
`DUPLICATE_POSITION`, "Already holding -10 on this contract"
([precheck.ts](../../app/server/src/trading/precheck.ts)). Two different
strategies should be able to hold the same contract, entered at different
prices with their own exits.

The gate is not the bug. The engine models **one trade per contract**:

- `syncPosition` reads Delta's *net* position for the symbol and writes it
  into the trade. Two trades of -10 would each be rewritten to -20.
- `protect()` matches resting reduce-only orders by order *type* (limit =
  target, stop = stop), not by client id. Each trade would edit or cancel the
  other's target and stop as "wrong price".

Removing the gate alone would corrupt both trades' books.

## Decision (current)

Keep `DUPLICATE_POSITION`. A strategy whose pick collides with an open trade
is refused and says so in `strategy_runs`.

## Proposed change

1. `protect` and `clearProtection` touch only orders whose client id carries
   this trade's stem (`roleOfClientId` already reads it).
2. `syncPosition` compares Delta's net against the **sum** of the open trades
   on that symbol, attributes by each trade's own fills, and raises an alarm on
   a gap it cannot explain instead of rewriting a trade.
3. The duplicate gate is scoped: a strategy is refused only when it already
   holds the contract itself (the `strategy_runs` claim already stops it
   entering twice a day); a manual ticket keeps the desk-wide rule.
4. Matrix cases: two trades on one contract -- either target fills alone, both
   stops fire, one closed by hand, close-all, restart recovery.
5. **One-lot live test** ([0002](0002-simulator-is-not-the-venue.md)): two
   reduce-only targets and two stop triggers on one contract -- does Delta hold
   them all, given it "will not hold two reduce-only orders totalling more than
   the position"?

**Tracked in:** [TODO.md](../TODO.md), "Needs the owner".
