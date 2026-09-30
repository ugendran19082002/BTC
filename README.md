# BTC options desk

A one-person trading desk for **BTC daily-expiry options on Delta Exchange
India**. It sells out-of-the-money premium on the daily contract -- from an
order ticket or on a schedule -- and manages each position to its exit:
resting target, stop watched on the offer with a backstop at the exchange,
exit time, settlement. Around that it records the option board and the
perpetual's tape and book, and draws them on one price chart.

**It trades real money.** The mode (paper or live) is decided by the server and
shown on every screen; see [decision 0010](docs/decisions/0010-server-decides-paper-or-live.md).

```
app/server   Fastify API and the trading engine (TypeScript, Node 24)
app/web      the screen (React 18, Vite, Tailwind, Radix, lightweight-charts)
deploy/      docker compose, nginx, deploy / backup / refresh scripts
harvester/   builds chain.db, two years of settled option chains
research/    the studies the strategy rests on, and their reports
docs/        how it works, why, and how to run it
```

## Start here

| To | Read |
|---|---|
| understand how it fits together | [docs/architecture.md](docs/architecture.md) |
| know why it is built the way it is -- **before changing `trading/`** | [docs/decisions/](docs/decisions/README.md) |
| run it locally and run the tests | [docs/guides/local-development.md](docs/guides/local-development.md) |
| deploy it, or look after it | [docs/guides/deploy.md](docs/guides/deploy.md), [docs/guides/operations.md](docs/guides/operations.md) |
| find a file, route, table or setting | [docs/reference/](docs/README.md#reference) |
| see what is open | [docs/TODO.md](docs/TODO.md) |

The full map of the docs is [docs/README.md](docs/README.md).

## Quick start (paper)

```bash
deploy/test-db.sh up                          # a throwaway PostgreSQL on :5433
cd app/server && npm ci && cp .env.example .env
#   set DATABASE_URL, and DELTA_LIVE_TRADING=0
npm run auth -- create <username>
npm run dev                                   # API on :8787
cd ../web && npm ci && npm run dev            # screen on :5173
```

Tests: `npm test` in `app/server`, `npx vitest run` in `app/web`.

## What the research says

Selling out-of-the-money premium on the daily contract made money over two
years of settled chains, with its losses in the tail. Every directional rule
tested on BTC -- momentum, SMC, CRT, order flow, volume profile -- was near
zero before fees and negative after them. Details:
[docs/research/findings.md](docs/research/findings.md). Nothing here is
trading advice.
