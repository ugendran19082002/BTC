# Operations

Day-to-day running of the live desk. Scripts are in [deploy/](../../deploy/).

## Scheduled jobs

On the host's crontab (`CRON_TZ=Asia/Kolkata`):

| When (IST) | Job | Log |
|---|---|---|
| 12:40 | `deploy/refresh.sh` -- harvest the settled chain into `chain.db` and hand it to the API | `refresh.log` |
| 18:00 | `deploy/backup-db.sh` -- `pg_dump`, keep the newest 3 | `backup.log` |

`refresh.sh` harvests yesterday and today into the repository's `chain.db` --
a day is skipped until its 12:00 UTC settlement has passed, so at 12:40 IST it
takes yesterday -- then copies the file into the API container and asks it to
reload, from inside the container. It was broken from 8 to 30 Sep 2026
([history](../history/2026-09.md), 30 Sep afternoon).

## Backups

```bash
./deploy/backup-db.sh                       # -> backups/btc_desk-<utc>.dump
./deploy/backup-db.sh --restore FILE        # stops the API, restores, starts it
```

A dump is one transaction's view of every table, taken while the desk trades.
Every deploy takes one first. `chain.db` is not in it: it is rebuilt by the
harvester and packed by `export-data.sh`. Dumps are on the same disk as the
database; off-host copies are open in [TODO.md](../TODO.md).

## Which statements cost what

The database loads `pg_stat_statements` (deploy/docker-compose.yml). It is switched on once, after the first
deploy that carries that setting -- the database container restarts on that deploy, so do it with no trade open:

```
docker exec btc-desk-db-1 psql -U desk -d btc_desk -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements; GRANT pg_read_all_stats TO desk_ro;"
```

Then, at any time, the ten statements that have cost the most:

```
docker exec btc-desk-db-1 psql -U desk_ro -d btc_desk -c "SELECT calls, round(total_exec_time) AS ms, round(mean_exec_time::numeric, 1) AS mean_ms, rows, left(query, 90) AS statement FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;"
```

Statements over 500 ms are also written to the database's log as they happen: `docker logs btc-desk-db-1 | grep duration:`.

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
2. `/api/health` -- `feed` (socket and REST freshness, reconnects), `db`, the
   migration ledger. From outside, without a session, it says only whether the
   desk and its database are up; the detail comes to a signed-in browser, or
   from inside the container:
   `docker compose -f deploy/docker-compose.yml exec api node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>r.text()).then(console.log)"`
3. `docker logs btc-desk-api-1` -- `grep 'socket open'` against `reconnects`
   tells a silent socket from a working one
   ([decision 0007](../decisions/0007-feed-age-is-the-newest-source.md)).
4. For a trade: its `trade_events`, in order. For a strategy: `strategy_runs`
   ([features/strategies.md](../features/strategies.md#why-a-strategy-is-refused)).
