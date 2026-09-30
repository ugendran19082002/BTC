# 0002 — A simulator is evidence about our logic, never about the venue's

**Status:** accepted · **Since:** 9 September 2026

## Context

This one cost real money. A resting limit target only fills when somebody
*offers* at it, so a decayed option's mark can fall straight through the level
untouched -- a short at 2.70 with a target at 1.10 did that while marked at
1.00. The target was changed to a `take_profit_order` trigger so Delta would
fire it on the mark. Delta fires a *buy* trigger the opposite way to the
reading of its docs, and it fired the instant it landed: a short sold at 7.00
with a target at 0.50 bought itself back at 7.00 within four seconds. Twice.

**Five tests asserted the target fired correctly, and all five passed** --
because `PaperExchange` had been written to the same reading of the docs as
the engine.

## Decision

A simulator built from the code's assumption cannot test that assumption; it
only proves the code agrees with itself. So:

- Anything about Delta's semantics -- which way a trigger fires, what an edit's
  `size` means, whether two reduce-only orders may rest together -- is settled
  by **one deliberate one-lot live test**, and the result is written down
  ([delta-api.md](../reference/delta-api.md)).
- Exits are built from the order property that cannot be got wrong: a limit
  buy fills at its price or better, never worse ([0006](0006-target-is-a-price-stop-is-an-exit.md)).
- `orders.test.ts` case 80 is the reproduction; 80b is the venue-independent
  property: an exit may never print worse than the level that asked for it.

## Consequences

The suite (1,200+ server cases) says nothing about Delta. Open items that need
a live test are marked as such in [TODO.md](../TODO.md).

**Where:** [exchange/paper.ts](../../app/server/src/trading/exchange/paper.ts),
[exchange/delta.ts](../../app/server/src/trading/exchange/delta.ts) ·
**History:** [2026-09.md](../history/2026-09.md), "A target that never fired".
