# 0009 — The trade journal is append-only and replayed

**Status:** accepted · **Since:** September 2026

## Decision

`trade_events` is appended and never edited; `trades` holds the reduced state.
`save()` writes the row and every unwritten event in one transaction;
`UNIQUE (trade_id, seq)` makes a double write impossible. `hydrate()` replays
the events through `recompute()`, so **a fix to the arithmetic repairs closed
trades too** -- which is how the realised-P&L bug (a missing x contract value,
`+$3.00` shown for `+₹255`) was fixed for trades that had already closed.

The engine awaits the journal write before anything that depends on it:
protection is sent only once the fill that needs it is committed.

Alerts hang off the journal and cannot touch a trade: `onEvent` runs after
the save, inside a try; `hydrate()` does not call it, so a restart does not
announce yesterday's fills again; and only what printed is announced.

## Consequences

The journal keeps its own mistakes: 68 `no_position_for_reduce_only`
refusals from 8 Sep are still in it, which is what an audit trail is for.

**Where:** [trading/store.ts](../../app/server/src/trading/store.ts) ·
**Tests:** `test/trading/store.test.ts` (the first is a plan changed and read back).
