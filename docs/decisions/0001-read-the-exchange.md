# 0001 — Anything labelled as what the exchange is doing is read from the exchange

**Status:** accepted · **Since:** September 2026

## Context

Broken three times, and each time it hid a deeper bug:

- The exits panel said "on the book now" and read the *plan*. The two agree
  until they do not, and the case where they differ is the only one worth
  showing.
- `protect()` decided what to place from memory rather than from the book,
  and put a second reduce-only order beside the one it meant to replace.
  Delta, which will not hold two reduce-only orders totalling more than the
  position, cancelled one of them; the screen said the target was 1.80 while
  the book had 26.40.
- The plan itself was stale, because `store.save` never wrote the `plan`
  column ([database.md](../reference/database.md#trades--one-row-per-trade)).

## Decision

`protect()` is a reconciler. It reads the book first, classifies each exit as
right / wrong price / unwanted / missing, prefers an in-place edit (`PUT
/v2/orders`), and falls back to a **verified** cancel before any replacement
is sent. An unverified cancel is exactly how two live orders happen.

Protection is sent only once the *exchange* agrees a position exists, not once
the desk thinks it does: sending reduce-only before Delta registered the fill
produced seventy `no_position_for_reduce_only` refusals in a loop on 8 Sep.

A read Delta refuses or times out on is *unknown*, never "no such order"
([delta-api.md](../reference/delta-api.md)).

## Consequences

More reads per trade (weight 3 each against 20,000 per five minutes). The
three reads `protect()` needs run in parallel, which took the naked window
after a fill from 1.81 s to one round trip.

**Where:** [engine.ts](../../app/server/src/trading/engine.ts) (`protect`,
`syncPosition`) · **Tests:** `test/trading/orders.test.ts`,
`test/trading/stop-orders.test.ts` · **History:**
[2026-09.md](../history/2026-09.md), "The bug behind 'SL and TGT update not working'".
