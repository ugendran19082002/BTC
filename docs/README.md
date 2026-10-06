# Docs

Organised by what you came to do. Pages that describe **what exists** are
generated from the code and checked by a test
([decision 0012](decisions/0012-generated-reference-docs.md)); everything else
is written by hand and says **why**.

## Understand

- [architecture.md](architecture.md) -- the map: processes, modules, background
  jobs, the life of a trade, money, alerts, security.
- [decisions/](decisions/README.md) -- the rules the desk runs on, one page each,
  with the incident that forced it. Read before changing `trading/`.
- [features/strategies.md](features/strategies.md) -- scheduled strategies: the
  scheduler, strike rules, entries, exits, and why a run is refused.
- [features/price-chart.md](features/price-chart.md) -- the price chart: every
  layer, detection rule and setup, and what the research says about each.
- [features/entry-setups.md](features/entry-setups.md) -- the 24 entry setups: twelve
  methods, with the timeframe chain and without it, their gates, targets and paper log.
- [features/entry-sl-tgt.md](features/entry-sl-tgt.md) -- all 81 methods: where each enters, where its
  stop and targets go, and the logic they share (gates, the paper log).

## Do

- [guides/local-development.md](guides/local-development.md) -- run it, test it.
- [guides/deploy.md](guides/deploy.md) -- first deploy and every deploy.
- [guides/operations.md](guides/operations.md) -- cron jobs, backups, moving
  servers, sign-in recovery, where to look when something is wrong.
- [guides/database-console.md](guides/database-console.md) -- Adminer, and the
  layers in front of it.

## Reference

| Page | What | Kept by |
|---|---|---|
| [reference/files.md](reference/files.md) | every file and what it is for | generated |
| [reference/api.md](reference/api.md) | every HTTP route and the session it needs | generated |
| [reference/schema.md](reference/schema.md) | every table, column, index and migration | generated |
| [reference/environment.md](reference/environment.md) | every environment variable | generated |
| [reference/database.md](reference/database.md) | what each table is for, and `chain.db` | hand |
| [reference/market-data.md](reference/market-data.md) | what Delta gives, live and historical, and what the desk keeps | hand |
| [reference/delta-api.md](reference/delta-api.md) | the Delta endpoints and error codes the code depends on | hand |

Regenerate the generated pages with `npm run docs` in `app/server`.

## Research

- [research/findings.md](research/findings.md) -- what every study found, in one page.
- [research/ideas.md](research/ideas.md) -- candidate strategy families, not yet tested.
- [research/btc-15m-movement-2y.md](research/btc-15m-movement-2y.md) -- how much BTC moves in each 15 minutes of
  the session (5:35 PM to 5:29 PM IST), in % and points, over two years.

## Open and past

- [TODO.md](TODO.md) -- open work, grouped, most important first.
- [history/2026-10.md](history/2026-10.md) -- the record of October 2026, newest first.
- [history/2026-09.md](history/2026-09.md) -- the record of September 2026:
  what broke, why, what it cost and what changed. Kept as written.
- [history/2026-09-11-security-audit.md](history/2026-09-11-security-audit.md) --
  the security audit of 11 Sep 2026.
