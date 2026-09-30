# 0008 — One PostgreSQL database, one schema; `chain.db` stays a file

**Status:** accepted · **Since:** 19 September 2026

## Context

Until 19 Sep the desk kept six SQLite files. They were separate for reasons
that were each right -- an order journal must not be replaced by a market-data
refresh, the sign-in must be copyable without the journal, the error log must
never be written by a test -- but those are separations of *ownership and
lifetime*, and a deploy could come up with `trades.db` migrated and the
strategy tables missing, and report healthy.

## Decision

- One PostgreSQL 17 database, `btc_desk`. Each store owns its tables and its
  migrations; nothing but the desk writes to any of them. One `pg_dump` is the
  whole desk; one ledger (`schema_migrations`) says what shape it is in; one
  pool means a leak shows up in one place.
- One schema, `public`, with the area as a name prefix where a bare name would
  be ambiguous (`auth_sessions`, `strategy_runs`) -- Adminer shows one schema at
  a time, and twenty-odd tables read fine as one list. The cost: the sign-in
  tables are no longer a namespace to grant or revoke as a block, so `desk_ro`
  is denied them table by table.
- Migrations are TypeScript, ordered, permanent ids (`<area>-NNN-what`), each
  in a transaction, advisory-locked, and **a failure stops the boot**. A
  shipped migration is never edited.
- `chain.db` stays a SQLite file: it is the harvester's read-only evidence,
  and 35 research scripts open it with `sqlite3`.

**Where:** [db/migrate.ts](../../app/server/src/db/migrate.ts),
[db/pool.ts](../../app/server/src/db/pool.ts) ·
**Reference:** [database.md](../reference/database.md), [schema.md](../reference/schema.md).
