# 0012 — Reference docs are generated from the code and tested

**Status:** accepted · **Since:** 30 September 2026

## Context

`FILE-INVENTORY.md` was written by hand on 9 Sep and was missing twenty files
by the 26th. `DB-INVENTORY.md` did not list `trend_paper`. Seven docs the code
pointed readers at did not exist. Hand-kept inventories rot, and a reader
following one is led to a smaller system than the one they are in.

## Decision

- Pages that say **what exists** are generated:
  [files.md](../reference/files.md) (from git and each file's header comment),
  [api.md](../reference/api.md) (from the Fastify app's own routes),
  [schema.md](../reference/schema.md) (from a freshly migrated database) and
  [environment.md](../reference/environment.md) (from every `process.env` read
  and the compose file). `npm run docs` in `app/server` writes them.
- `test/docs/docs.test.ts` fails when a committed page differs from what the
  code renders, when a relative link in `README.md` or `docs/` points at
  nothing, and when code or config names a `docs/*.md` that does not exist.
- Pages that say **why** stay hand-written: [architecture.md](../architecture.md),
  these decisions, [database.md](../reference/database.md), the guides.
- A file or route without a header comment shows a dash. The fix is the
  comment, never an edit to the page.

## Consequences

Adding a file, route, table or environment variable means running
`npm run docs` and committing the result, or the suite fails. A new
environment variable must get a line in `ENV_NOTES`, or the render fails.

**Where:** [gen-docs.ts](../../app/server/src/docs/gen-docs.ts).
