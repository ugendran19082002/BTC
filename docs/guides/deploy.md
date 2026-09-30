# Deploy

The desk runs as the compose project `btc-desk` from
[deploy/docker-compose.yml](../../deploy/docker-compose.yml). Everything below
is run from the repository root on the host (or with `--host` from your
machine).

**The desk may be trading live.** Deploy with nothing open where you can; the
engine recovers open trades on restart ([decision 0009](../decisions/0009-append-only-journal.md)),
but a restart is still a gap in the stop watch.

## First time on a host

1. `cp deploy/.env.example deploy/.env` and set `POSTGRES_PASSWORD`
   (`openssl rand -base64 24`).
2. `cp app/server/.env.example app/server/.env` and fill it in
   ([reference/environment.md](../reference/environment.md)). Never commit either file.
3. `./deploy/deploy.sh`
4. Put `chain.db` on the data volume: `./deploy/refresh.sh`, or move a whole
   desk with `deploy/export-data.sh` on the old host and
   `deploy/import-data.sh <tarball>` on the new one.
5. Point the edge proxy at `172.17.0.1:${WEB_PORT:-8099}`.

## Every deploy

```bash
./deploy/deploy.sh                  # back up, test, build, start, health-check, roll back on failure
./deploy/deploy.sh --check          # validate only; nothing built or started
./deploy/deploy.sh --no-test        # skip the suites (or deploy/deploy-fast.sh)
./deploy/deploy.sh --host user@ip   # build here, ship, run there
./deploy/deploy.sh --no-backup      # skip the database backup (not recommended)
./deploy/deploy.sh --no-prune       # keep every old image
```

What `deploy.sh` does, in order:

1. **Refuses to build if a credential is reachable** from the build context.
2. Installs dependencies if they changed.
3. Starts the test database, runs both suites and both typechecks.
4. Builds the images at a new tag.
5. **Backs up the database** (`backup-db.sh`) and stops if the backup fails.
6. Starts the new images and waits for `GET /api/health`.
7. **Rolls back to the previous images** if they do not come up healthy.
8. Prunes old image tags, keeping the running and previous ones.

## After a deploy

`deploy.sh` prints `/api/health` as the container itself sees it: the applied
migrations, the database round trip, both sockets' state and the dataset's date
range -- so a deploy that did not migrate, or a feed that is not connected, is
visible at once. (From outside, without a session, the route says only that the
desk is up.) Then look at the **errors** tab.
