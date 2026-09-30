# Operations

Day-to-day running of the live desk. Scripts are in [deploy/](../../deploy/).

## Scheduled jobs

On the host's crontab (`CRON_TZ=Asia/Kolkata`):

| When (IST) | Job | Log |
|---|---|---|
| 12:40 | `deploy/refresh.sh` -- harvest the settled chain into `chain.db` and hand it to the API | `refresh.log` |
| 18:00 | `deploy/backup-db.sh` -- `pg_dump`, keep 14 days | `backup.log` |

**`refresh.sh` is not updating the desk's dataset** -- see
[TODO.md](../TODO.md), "The desk's dataset stopped on 8 Sep".

## Backups

```bash
./deploy/backup-db.sh                       # -> backups/btc_desk-<utc>.dump
./deploy/backup-db.sh --restore FILE        # stops the API, restores, starts it
```

A dump is one transaction's view of every table, taken while the desk trades.
Every deploy takes one first. `chain.db` is not in it: it is rebuilt by the
harvester and packed by `export-data.sh`. Dumps are on the same disk as the
database; off-host copies are open in [TODO.md](../TODO.md).

## Moving to another server

```bash
./deploy/export-data.sh           # old host: chain.db + btc_desk.dump
./deploy/export-data.sh --chain   # chain.db only, for a paper copy
./deploy/import-data.sh FILE      # new host, after its first deploy.sh
```

The sign-in tables open only under the same `DESK_SESSION_SECRET`. Roles are
not in a dump: run `deploy/db-readonly-role.sh` and `deploy/db-admin-role.sh`
again on the new host.

## Sign-in

On the host, in the API container or `app/server`:

```bash
npm run auth -- status
npm run auth -- set-password
npm run auth -- reset-2fa        # lost phone: set it up again at the next sign-in
npm run auth -- sign-out-all
```

## Looking at the database

Adminer, read-only by default: [database-console.md](database-console.md). What
each table holds: [reference/database.md](../reference/database.md).

## When something looks wrong

1. The **errors** tab -- server, browser, exchange and trading failures in one
   list, folded by fingerprint.
2. `GET /api/health` -- `feed` (socket and REST freshness, reconnects), `db`,
   the migration ledger.
3. `docker logs btc-desk-api-1` -- `grep 'socket open'` against `reconnects`
   tells a silent socket from a working one
   ([decision 0007](../decisions/0007-feed-age-is-the-newest-source.md)).
4. For a trade: its `trade_events`, in order. For a strategy: `strategy_runs`
   ([features/strategies.md](../features/strategies.md#why-a-strategy-is-refused)).
