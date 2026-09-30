# 0007 — A feed's age is the age of the newest thing that arrived, from any source

**Status:** accepted · **Since:** 21 September 2026

## Context

On 21 Sep the ticker socket went silent, and for 32 hours every reopen was
dropped on the very next tick: silence was measured from the *dead* socket's
last message, so a new socket still in its handshake already looked twenty
seconds silent. 3,833 reconnects, none heard. The REST poll carried the board
the whole time, yet the screen said **market 1d**, because freshness read the
socket's timestamp ahead of the fresher REST batch.

## Decision

- Silence is counted from the later of the last message and the last attempt
  (`openedAt` in `TickerSocket` and `FlowSocket`). A reopen gets the full stale
  window to connect; a socket that never opens is still given up on.
- "How old is this" is the newest of every source that feeds it, never the
  first non-null one. `/api/health`'s `feed` block keeps a stale fallback and a
  stale primary apart, because they are different alarms.
- A reconnect loop that never logs `open` is an outage, not noise: compare
  `docker logs ... | grep 'socket open'` against `reconnects` in `/api/health`.

**Where:** [delta-socket.ts](../../app/server/src/market/delta-socket.ts),
[flow-socket.ts](../../app/server/src/market/flow-socket.ts) ·
**Tests:** `test/market/delta-socket.test.ts`.
