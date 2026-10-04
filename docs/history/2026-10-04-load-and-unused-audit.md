# Audit: load, slowness, and what is not related to signals

Taken on 4 Oct 2026, 15:45 to 16:15 IST, on the live desk (read-only). Rebuilt
the same evening, after the owner's answer to it: what was done, and what is
still open.

Every item carries one of three labels:

| Label | Meaning |
|---|---|
| **Important** | Do it. It touches safety, or it is most of the load, or it can stop the desk. |
| **Optional** | Worth doing when there is time. The gain is small or it is only cleanup. |
| **No need** | Leave it as it is. It was checked and it is fine, or it is in use. |

## The short version

- **Done:** the unused code, `large_prints`, the trend paper, the best pick's alert and automatic trade, the host cleanup, the signal history's page size and cache, and a Telegram fault found on the way.
- **Still open, Important:** the two loops that are most of the load, the stop that does not rest at Delta, the lots gathered on one strike, the disk, and the database's slow-query statistics.
- **Not removed, on purpose:** `book_heat_1m` (the signal engine reads it) and the time-of-day strategies (they share the signal runner; removing them is a change of its own).

## 1. Done on 4 Oct 2026

| What | What was done | Checked by |
|---|---|---|
| Day summary lost on Telegram | 109 trades made a 5,190-character message; Telegram takes 4,096. Long messages now go in parts, cut between lines. | 3 new tests; the notify tests pass |
| `large_prints` | Writer removed; table dropped by `market-017-drop-large-prints`. 85,773 rows exported first to `cache/reports/`. The per-minute large-trade counts in `trade_flow_1m` are unchanged. | New drop test; the flow test still counts large trades |
| Trend paper | Module, route, five-minute recorder and script removed; table dropped by `strategy-007-drop-trend-paper`. 31 rows exported first. | New drop test |
| Best-pick alert and automatic trade | The one-minute watcher, both modules, the `/api/trade/auto-trade` routes, the settings switches and the limits card removed. Saved keys deleted by `trading-007-retire-best-pick-settings`. The best-pick card and its premium floor stay. | New settings test; web settings tests rewritten |
| Code nothing ran | 9 server files, 7 web files and 7 study scripts removed, with their tests. Git history has them. | Both typechecks; the unused-export check |
| Signal history | Opens on 10 rows (10 / 25 / 50 / 100). The count and the totals are held by the filters, so a page turn or a sort reads only the page's rows. | New cache test; the history tests |
| Retired analytics container | Stopped and removed. Nothing pointed at it. | — |
| Stopped containers | 13 removed (banknifty, house, two old harness databases). Their volumes are kept. | — |
| Old SQLite files | `trades.db` and `errors.db` archived to `backups/old-sqlite-2026-10-04.tar.gz`, then removed. | — |
| Binance cache | `cache/binance` (188 MB) deleted. Its only readers were the removed study scripts. | — |
| Backups | `backups/` went from 820 MB to 183 MB: the newest three database dumps are kept, and `deploy/backup-db.sh` now keeps three by default (it kept 14). The four one-off archives are untouched. | The three kept dumps were read back with `pg_restore -l` |
| Order-history CSV | Taken out of git and added to `.gitignore`. The file stays on disk. It is still in the git history. | — |

Test totals after the changes: server 1,344 of 1,344 in the touched areas, web 1,124 of 1,124, docs 3 of 3.

**Live:** the desk was redeployed during this work as `8451461`. On it `large_prints` and `trend_paper` are dropped, the health check is green, no error has been logged, and signals are being written and decided. The settings-key cleanup, the docs and this file are in later commits and go with the next deploy.

**A correction to the first version of this file.** It said the signal history counts the whole table on every 5-second poll. It does not: the answer was already cached until the data changes, so the count ran about four times a minute, at 16 ms. The change above is a smaller gain than that line promised.

## 2. Still open

### Important

| # | What | Detail | What to do |
|---|---|---|---|
| 1 | Signal trades have no stop at Delta | At 15:27 IST all 22 open signal trades had a resting target and none had an option stop. If the desk is down, nothing at Delta stops them. | Decide whether a stop should rest at Delta. See `docs/TODO.md`, "Signal trades carry no stop at Delta". |
| 2 | Most lots sit on one strike | 97 of 110 lots were on one contract: 19 trades of 4 strategies. The day closed at a net loss of ₹83.94 over 109 trades. | Decide on a limit per contract. See `docs/TODO.md`, "The else strike gathers the book on one strike". |
| 3 | Paper grader re-reads every working setup each second | `app/server/src/entry/paper.ts`, `workingRows`, called from `app/server/src/entry/live-grade.ts`. 528 rows, 277 kB per read. | Keep the working rows in memory and read only what changed. |
| 4 | Status is rebuilt every second and re-reads the whole day's trades | `app/server/src/trading/service.ts` (`STATUS_REFRESH_MS`) and `app/server/src/trading/store.ts` (`realisedBreakdownSince`). 124 trades that day, about 250 rows a second. It grows with every signal taken. | Keep the day's realised figure as a running total; update it when a trade closes. |
| 5 | Every read of trades scans the whole journal | `app/server/src/trading/store.ts`, the events read. About 60 to 70 full scans a minute of `trade_events`. | Read the journal only for the trades that need it. Goes with item 4. |
| 6 | Disk is 85% full (61 of 75 GB) | Docker images: 7.5 GB can be freed. Build cache: 5.3 GB. | Prune unused Docker images and build cache. |
| 7 | The database cannot name its slow queries | `pg_stat_statements` is not installed. Items 4 and 5 are read from table counters and the code. | Install it. It needs a database restart, so do it when no trade is open. |
| 8 | Full test runs on this machine while the desk trades | They pushed the load to about 6 on 4 CPUs. | Run only the tests of the part that changed. |

Items 3, 4 and 5 are most of the 0.8 MB a second the database sends the API. They are on the real-money path, so each needs its own tests before deploy.

### Optional

| What | Detail | What to do |
|---|---|---|
| Time-of-day strategies | 4 saved, all off, last run 2 Oct. They share the runner, the store and the rules with the signal strategies, and about 95 tests use them. | Remove as one change of its own, with the signal tests as the guard. Switched off, they cost nothing. |
| `/api/entry/record` takes 694 ms | `app/server/src/entry/paper.ts`, `entryRecord`, loads all 13,047 setups and groups them in JavaScript. Asked every 60 s. | Group in SQL, as the methods report already does. |
| `/api/candles` takes 680 ms | `app/server/src/http/routes/desk.routes.ts` has no cache of its own. | Cache each timeframe for a few seconds. |
| Signal history totals over all days take 235 ms | Only with "today" switched off. Postgres picks 13,000 index lookups. | Leave, or rewrite the join. |
| `/api/strategies` takes 459 ms | Cause not found yet. | Time each step once, then fix the slow one. |
| `/api/perp` takes 352 ms | Five reads at once, one of them up to a day of `option_flow_1m`. | Shorten the window, or cache it. |
| `/api/settings` takes 299 ms | Asks the exchange for the account first. | Use the figure the status already holds. |
| Strategy editor polls a board per timeframe | `app/web/src/components/strategy/SignalRuleEditor.tsx`, every 10 s while open. | One request for all timeframes. |
| `option_flow_1m` (106 MB) | Read only by the option-flow panel of `/api/perp`. | Keep fewer days. |
| `option_snapshots_1m` (30 MB for 45k rows) | 2.4 million rows inserted and deleted; read only by `/api/changes`. | Leave, or vacuum it now and then. |
| `research/` (54 MB) | Its Python studies still read `research/cache-5m.json`. | Delete what is no longer studied. |
| `app/server/audit.tmp.mts` | A stray file from 1 Oct, used by nothing. | Delete after one look. |

Route times come from 7 minutes of logs with one browser open, so they are a first reading.

## 3. No need

| What | Why it is fine |
|---|---|
| `book_heat_1m` (14 MB) | **Do not remove.** The signal engine reads it: `pulled-wall` gave 3,200 TRADE signals in the last 7 days and `replenished-wall` 1,544, and every read carries its walls. Removing it would change which signals the strategies take. |
| `harvester/`, `Dockerfile.harvester` | In use: `deploy/refresh.sh` runs it daily to refresh `chain.db`. |
| `cache/candles` (25 MB) | Still read by the entry studies in `app/server/scripts/`. |
| Web bundle | Gzip is on, assets are cached for a year, the largest file is 232 kB. |
| Database memory settings | `shared_buffers` is the default 128 MB, but the cache hit rate is 99.4%. |
| Unused indexes | Nine, each 40 kB or less. |
| `/api/health`, `/api/chain` | 12 ms and 96 ms. The server itself is not blocked. |
| Session lookup on every request | A scan of an 8-row table. |
| Overview and chain board, P&L report and `mtm_samples`, manual order ticket | In use on screen. |
| `app/server/src/domain/score.ts`, `calibration.ts`, `app/server/src/backtest/backtest.ts` | They look unrelated, but the signal runner imports them. |
| `chain_features` | Small (1.5 MB), and `app/server/src/market/flow.ts` reads it. |
| Signal-path tables | `entry_signals`, `entry_setups`, `entry_methods`, `entry_gates`, `entry_alerts`, `entry_alert_log`, `entry_cleared`, `strategies`, `strategy_signal_runs`, `trades`, `trade_events`, `settings`, `errors`, `perp_snapshots`, `trade_flow_1m`, `index_1m`, `book_heat_1m`, `oi_snapshots`, `option_snapshots`. All needed. |
| The git-ignored keys file at the repo root | It is ignored, so it is not pushed. It was not opened. Never commit it. |

## Numbers behind the audit

| Measure | Value |
|---|---|
| Database to API traffic | 730 to 925 kB a second; 24.4 GB in 14 hours |
| API process | About 25% of one CPU, 187 MB |
| Database | 439 MB on disk, 343 of 512 MB memory in use |
| Requests from one open screen | About 42 a minute, plus the live stream |
| Host | 4 CPUs, 7.7 GB; shared with the editor and its tools (about 1.4 GB) |
| Largest tables | `option_snapshots` 218 MB, `option_flow_1m` 106 MB, `option_snapshots_1m` 30 MB, `entry_signals` 21 MB, `entry_setups` 11 MB |

The removals above do not move the traffic figure: it comes from items 3 to 5.

## Where to go next

1. Decide items 1 and 2: they are about money, not speed.
2. Free disk space (item 6): quick, and no code changes.
3. Fix the two loops (items 3 to 5): this removes most of the load.
4. Install `pg_stat_statements` (item 7) at a quiet time, then measure again.
5. Remove the time-of-day strategies, as a change of its own.
