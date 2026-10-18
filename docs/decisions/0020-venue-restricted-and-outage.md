# 0020 — When Delta takes no new orders, or does not answer, the desk holds still and says so once

**Status:** accepted and built, 18 October 2026 · **Stands with** [0006](0006-target-is-a-price-stop-is-an-exit.md), [0015](0015-read-the-whole-book.md)

## Context

The night of 17–18 October 2026, as the live log has it:

- **1:02–1:21 AM IST** — Delta answered HTTP 502 to everything. The desk read on as usual: 1,675 failed reads of
  `/v2/orders`, 449 of `/v2/positions/margined`, 1,290 order look-ups -- each look-up's path a row of its own in the
  log, 98 of them, so Logs said 108 for what was one outage.
- **1:30–1:37 AM** — Delta in `market_disrupted_cancel_only_mode`: cancels taken, nothing new. 1:30 is a step of the
  strategies' target-by-time ladder. The desk moved 49 trades' targets: each edit was refused, so each fell back to
  cancel-and-replace -- and the cancel was **taken**, the new order **refused**. The desk took its own resting
  targets off the book. Then 388 refusals (each target tried again, backing off) and 49 "POSITION UNPROTECTED"
  alarms, over positions whose **stops never moved** -- the alarm was the target's.

## Decision

1. **Cancel-only mode is the venue's state, not an order's refusal** (`VenueRestricted`, `venueRestriction` in
   `trading/exchange/delta.ts`). Noted at the first refusal that says `market_disrupted_*`, held 30 s past the last,
   for every account (it is Delta's, not one account's); said once in the log when it starts and once when it ends.
2. **While it holds, nothing that opens risk is sent** -- no entry, no leverage change (they are refused before they
   leave). **A close is always sent** when it is due: it is the order that must go the moment Delta takes orders again.
3. **Resting protection is left exactly where it is** (`protect`, `protectLong`). An edit refused for the venue's
   state keeps the order -- never the cancel-and-replace that removes it with nothing to put back. Once the desk knows,
   it does not touch the book at all until the hold ends. A position with **no stop on at all** still tries, and still
   alarms: that one is unprotected.
4. **A book owed a change is asked again** (`protectionOwed`): protection held back or failed with its orders still
   resting -- a target at its old level is not "missing", and was never re-sent. The poll asks again after the
   back-off, so the 1:30 step reaches the book when Delta does.
5. **The alarm is the stop's** (`protection_failed.leg`, `machine.ts`). A target that did not go on while the stop
   rests is a note on the trade, not "POSITION UNPROTECTED" and not a phone call.
6. **Delta not answering holds the reads back** (`readFailed`): after three reads in a row fail on Delta's side, reads
   are answered as the outage at once, without asking, for 2 s doubling to 30 s; said once when it starts and once when
   Delta answers. Writes are never held.
7. **One trouble is one log row** (`groupWhere`, `observability/errors.ts`): ids (five digits or more) come out of a
   request's path -- `GET /v2/orders/client_order_id/:id` -- and stay in the row's context. The browser counts the
   proxy's 502/503/504 while the server restarts like a dropped connection: written down only if it lasts.

## Consequences

- During cancel-only mode a strategy's signal is refused in words ("Delta is in cancel-only mode … not sent") and the
  live check counts it as refused, as before for any refusal.
- The target ladder's step at such a moment lands late, when Delta takes orders again -- not never, and not by taking
  the old target off first.
- Tests: `test/trading/venue-restricted.test.ts` (the 1:30 step replayed both ways, the adapter's hold, the read
  outage), `test/errors.test.ts` (one row per trouble), `src/api/client.test.ts` (the proxy's 502).
