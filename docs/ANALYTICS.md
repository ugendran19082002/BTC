# The analytics service

Python, FastAPI, in `analytics/`. Display-only models for the desk's screens.

## The boundary — what may and may not move here

**Stays in Node, always:** anything the order path reads. The trading engine,
the strategy runner and its gates, auth, Telegram — and the domain modules they
import: `score`, `ev`, `shock`, `structure`, `probability`, `bs`, `best-trade`.
The desk must trade identically whether or not this service is running.

**Lives here:** models a screen reads and nothing else does. Today: the measured
Down / Side / Up outlook. Candidates to move next, one at a time, each with a
parity test proving identical output: `forecast`, `direction`, `recommend`,
`calibration` (all read only by `desk.routes.ts`).

Check before moving anything: `grep` for the module's importers under
`src/trading`, `src/strategy`, `src/notify`, `src/auth`. Any hit keeps it in Node.

## How a request flows

    browser → Node /api/chain
                ├─ Node builds its own outlook (always)
                └─ POST analytics:8800/v1/outlook   (1.2 s timeout)
                      ← measured rows → attached by label
    no answer → the card shows Node's own figures; one warning in the error log
                per outage; the next try waits 30 s

Node sends the candles it already caches (every bar, the forming one too); the
service drops unfinished bars itself, exactly as the history never saw one.

## The measured outlook

    research/measure_outlook.py     counts 280,326 five-minute bars → outlook_states
    analytics/app/features.py       RSI, EMA stack, momentum — ONE copy, used by
                                    both the measurement and the live service
    analytics/app/outlook.py        labels now, looks up the matching rows

Rules the model keeps (see the file's docstring for why):

* Side band = the tercile of |move| per horizon, so no information reads 33/33/33.
* A state's lean or calm counts only if it held in 2024, 2025 and 2026 separately
  (3+ points) and z > 3 on non-overlapping windows. Otherwise it is not shown.
* The arrow follows only a lean that held. The card lights only an outcome that
  held (Side only when *calmer*).

What the measurement found (17 Sep 2026): calm clusters strongly (after a quiet
window Side is ~44% vs 33%, 5m–1h); short-horizon direction leans are small and
*mean-reverting* (after a drop, Up +5–6 points at 15m–4h); nothing directional
survives past 6h, and nothing at all at 24h.

Option-chain inputs (OI, volume, ΔOI, PCR, IV skew) are **not** in the model:
the desk has no intraday history of them — `oi` holds ~2 strikes a day. They
cannot be measured until that history exists (see TODO).

## Runbook

**Tests** — `cd analytics && .venv/bin/python -m pytest -q` (deploy.sh runs them).

**Re-measure** (after refreshing `research/move-5min.csv`):

    python3 research/measure_outlook.py          # writes the repo's chain.db
    python3 research/outlook_parity.py           # refreshes the test vectors

**Publish to the live database** — into the `analytics` schema of the desk's
PostgreSQL, from a throwaway container on the compose network (the database has
no host port):

    docker run --rm --network btc-desk_default --env-file deploy/.env \
      -v "$PWD":/repo:ro btc-desk-analytics:latest \
      sh -c 'python /repo/research/publish_outlook_states.py /repo/chain.db \
               "postgres://desk:$POSTGRES_PASSWORD@db:5432/btc_desk"'

The two tables are replaced and `analytics_publish_meta.published_at` stamped in
one transaction, so the service never sees half a publish. It checks the stamp
at most every 30 s and serves the new rows; no restart. A SQLite path as the
target still works, for local runs against `chain.db`.

**Is it answering?**

    docker compose -f deploy/docker-compose.yml exec analytics \
      python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8800/health').read())"

`outlook_rows: 0` means the table was never published (or the database is away):
the cards show Node's own figures until it is.

**Tests against PostgreSQL** — `tests/test_pg.py` publishes, reads and
re-publishes against a real server; it runs when `TEST_PG_URL` is set
(`deploy/test-db.sh up` prints one) and skips otherwise. deploy.sh sets it.
