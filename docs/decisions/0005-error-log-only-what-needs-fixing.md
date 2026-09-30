# 0005 — The error log holds only what needs fixing

**Status:** accepted · **Since:** September 2026

## Context

This desk says no for a living: the spread gate, the premium floor, the mode
switch refusing to flip with a position open. Every one of those was writing
an error row, and a log where most rows are the desk working is a log where
the real failure gets scrolled past. The test suite also used to file its
fixture refusals into the live log: two rows with 72 folded occurrences turned
out to be a `client_order_id` fixture and a stack ending in `node:assert`.

## Decision

- [refuse.ts](../../app/server/src/http/refuse.ts) lets a route mark a 4xx it
  *meant*; `worthLogging(status, deliberate)` is the whole rule in one testable
  function. Unmarked responses are still logged -- including a 400, which is a
  bug in our own screen -- so forgetting to mark one makes the log noisier,
  never blinder.
- Server, browser, exchange and trading failures land in one `errors` table,
  folded by fingerprint, redacted before write
  ([database.md](../reference/database.md#errors--every-failure-one-table)).
- `ErrorLog.record()` never throws and never waits.
- Every test process gets its own `btc_test_*` database; `env.test.ts` fails if
  `DATABASE_URL` names anything else.

## Consequences

An empty error log on a live desk is a result, not a gap.

**Where:** [observability/errors.ts](../../app/server/src/observability/errors.ts) ·
**Tests:** `test/errors.test.ts`, `test/env.test.ts`.
