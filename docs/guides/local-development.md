# Local development

Run the desk on your own machine, on paper, and run its tests.

## What you need

- Node 24 and npm
- Docker (for the throwaway test database)
- Python 3, only for `harvester/` and `research/`

## Install

```bash
cd app/server && npm ci
cd ../web && npm ci
```

## A database

The suite and the doc generator need a PostgreSQL. `deploy/test-db.sh` runs a
throwaway one (tmpfs, fsync off) on `127.0.0.1:5433`:

```bash
deploy/test-db.sh up      # start it, print its URL
deploy/test-db.sh down    # remove it, data and all
```

Every test process creates its own `btc_test_<random>` database inside it and
drops it on exit (`app/server/test/env.ts`). If yours is on another port --
the harness on the production host is on **5434** -- say so:

```bash
export TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:5434/postgres
```

## Run the API

```bash
cd app/server
cp .env.example .env
```

In `.env`, set at least `DATABASE_URL` (a database other than `postgres`
inside the test server is fine) and `DELTA_LIVE_TRADING=0`, so the desk
cannot reach the real exchange whatever else is set. Every variable is listed
in [reference/environment.md](../reference/environment.md).

Sign-in is required. Create the user, then start the API:

```bash
npm run auth -- create <username>   # also: status, set-password, reset-2fa, sign-out-all
npm run dev                         # tsx watch on :8787
```

`chain.db` is optional locally; without it the backtest and calibration read
nothing. Copy one from the server with `deploy/export-data.sh --chain`.

## Run the screen

```bash
cd app/web
npm run dev        # Vite on :5173, /api proxied to :8787 (API_URL to change it)
```

## Tests and checks

| Where | Command | What |
|---|---|---|
| `app/server` | `npm test` | ~1,200 cases, `node:test` via tsx; needs the test database |
| `app/server` | `npm run typecheck` | |
| `app/web` | `npx vitest run` | ~950 cases, jsdom |
| `app/web` | `npm run typecheck` | |
| `app/web` | `npm run test:responsive` | loads the running app at 360-1920 px in headless Chromium |
| `app/server` | `npm run docs` | regenerates `docs/reference/*` -- run it after adding a file, route, table or env var |

`test/docs/docs.test.ts` fails if a generated page is stale or a link in the
docs points at nothing ([decision 0012](../decisions/0012-generated-reference-docs.md)).

## Before changing the trading engine

Read [the decisions](../decisions/README.md). Nearly every test in
`test/trading/orders.test.ts` is named after the incident that produced it;
a failing one is usually telling you which loss you are about to repeat.
