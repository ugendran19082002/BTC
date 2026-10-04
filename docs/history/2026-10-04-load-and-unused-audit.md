# Audit: load, slowness, and what is not related to signals

Taken on 4 Oct 2026, 15:45 to 16:15 IST, on the live desk (read-only). Nothing was changed.

Every item carries one of three labels:

| Label | Meaning |
|---|---|
| **Important** | Do it. It touches safety, or it is most of the load, or it can stop the desk. |
| **Optional** | Worth doing when there is time. The gain is small or it is only cleanup. |
| **No need** | Leave it as it is. It was checked and it is fine, or it is in use. |

## The short version

- The database sends the API about 0.8 MB every second (24 GB in 14 hours). Almost all of it comes from two loops that run every second.
- Open signal trades have a target resting at Delta and no stop there. The stop is the perp SL, watched by the desk.
- The disk is 86% full.
- About 20 source files and one database table are used by nothing on the running desk.

## 1. Important

| # | What | Detail | What to do |
|---|---|---|---|
| 1 | Signal trades have no stop at Delta | At 15:27 IST all 22 open signal trades had a resting target and none had an option stop. If the desk is down, nothing at Delta stops them. | Decide whether a stop should rest at Delta. Written up in `docs/TODO.md`, "Signal trades carry no stop at Delta". |
| 2 | Most lots sit on one strike | 97 of 110 lots were on `P-BTC-84600-041026`: 19 trades of 4 strategies. The else strike gathers them. | Decide on a limit per contract. Written up in `docs/TODO.md`, "The else strike gathers the book on one strike". |
| 3 | Paper grader re-reads every working setup each second | `app/server/src/entry/paper.ts` line 404, called from `app/server/src/entry/live-grade.ts` line 50. 528 rows, 277 kB per read. | Keep the working rows in memory and read only what changed. |
| 4 | Status is rebuilt every second and re-reads the whole day's trades | `app/server/src/trading/service.ts` line 64 and `app/server/src/trading/store.ts` line 190. 124 trades today, about 250 rows a second. It grows with every signal taken. | Keep the day's realised figure as a running total; update it when a trade closes. |
| 5 | Every read of trades scans the whole journal | `app/server/src/trading/store.ts` line 246. About 60 to 70 full scans a minute of `trade_events` (4,631 rows). | Read the journal only for the trades that need it. Goes with item 4. |
| 6 | Disk is 86% full (62 of 75 GB) | Docker images: 7.5 GB can be freed. Build cache: 5.3 GB. `backups/`: 816 MB. A full disk stops the database writing. | Prune unused Docker images and build cache. Thin out old backups. |
| 7 | The database cannot name its slow queries | `pg_stat_statements` is not installed. Items 4 and 5 are read from table counters and the code, not from the queries themselves. | Install it. It needs a database restart, so do it when no trade is open. |
| 8 | Full test runs on this machine while the desk trades | My full test runs pushed the load to about 6 on 4 CPUs while the desk was live. | Run only the tests of the part that changed. Full suite only when flat, or on another machine. |
| 9 | Which changes are live is not confirmed | The desk was redeployed at 15:41 IST as `04cacdd-dirty-101124`. | After the next deploy, read the build line at the foot of the signal strategies card. |

Items 3, 4 and 5 are on the real-money path. Each needs its own tests before deploy.

## 2. Optional

### Speed

| What | Detail | What to do |
|---|---|---|
| `/api/entry/record` takes 694 ms | `app/server/src/entry/paper.ts` line 539 loads all 13,047 setups and groups them in JavaScript. Asked every 60 s. | Group in SQL, as the methods report already does. |
| `/api/candles` takes 680 ms | `app/server/src/http/routes/desk.routes.ts` line 418 has no cache of its own. | Cache each timeframe for a few seconds. |
| Signal history counts the whole table | `app/server/src/entry/signals.ts` line 396, asked every 5 s. 24,753 rows, 16 ms. Grows with the history. | Count only when a filter changes, or count the day. |
| `/api/strategies` takes 459 ms | Cause not found yet. It was this slow before Delta's wallet figure was added. | Time each step once, then fix the slow one. |
| `/api/perp` takes 352 ms | Five reads at once, one of them up to a day of `option_flow_1m`. | Shorten the window, or cache it. |
| `/api/settings` takes 299 ms | Asks the exchange for the account first. | Use the figure the status already holds. |
| Strategy editor polls a board per timeframe | `app/web/src/components/strategy/SignalRuleEditor.tsx` line 102, every 10 s while open. | One request for all timeframes. |

Route times come from 7 minutes of logs with one browser open, so they are a first reading.

### Database

| What | Detail | What to do |
|---|---|---|
| `large_prints` (7.8 MB) | Written every minute, read by nothing. | Stop writing it and drop it, unless research wants it. |
| `option_flow_1m` (106 MB) | Read only by the option-flow panel of `/api/perp`. | Keep fewer days. |
| `option_snapshots_1m` (30 MB for 45k rows) | 2.4 million rows inserted and deleted; read only by `/api/changes`. | Leave, or vacuum it now and then. |
| `trend_paper`, `strategy_runs` | Small. Used only by trend paper and time-of-day strategies. | Go with those features, below. |

### Features that run but are not on the signal path

| Feature | State now | What to do |
|---|---|---|
| Best-pick auto trade and its alert | Both switched off. The 60 s watcher still runs. | Remove if it will not be used again. The settings live inside `app/server/src/trading/service.ts`, so it needs care. |
| Time-of-day strategies | 4 saved, all off, last run 2 Oct. | Remove if signals have replaced them. They share the runner, store and types with signals. |
| Trend paper | Still writing (last 13:30 today). | Stop it if nobody reads it. |

### Code used by nothing on the running desk

Only tests or study scripts import these. Removing them changes nothing on the desk.

- Server:
  - `app/server/src/backtest/momentum.ts`
  - `app/server/src/backtest/momentum-study.ts`
  - `app/server/src/backtest/candle-cache.ts`
  - `app/server/src/backtest/signal-outcome.ts`
  - `app/server/src/domain/break-risk.ts`
  - `app/server/src/domain/indicators.ts`
  - `app/server/src/domain/level-mode.ts`
  - `app/server/src/domain/market-state.ts`
  - `app/server/src/domain/patterns.ts`
- Web:
  - `app/web/src/components/live/Liveness.tsx`
  - `app/web/src/components/desk/signal-export.ts`
  - `app/web/src/components/desk/signal-track.ts`
  - `app/web/src/lib/break-risk.ts`
  - `app/web/src/lib/smc/readout.ts`
  - `app/web/src/lib/trend/breakout.ts`
  - `app/web/src/lib/volume-profile.ts`
  - the study scripts in `app/web/scripts/`

### Files and containers on the host

| What | Detail | What to do |
|---|---|---|
| `btc-desk-analytics-1` | Retired, no longer in the compose file, still running (129 MB). | Stop and remove it. |
| 15 stopped containers | 13 from other projects (banknifty, house), 2 old harness databases. | Remove them. |
| Order-history CSV at the repo root | An account export, tracked in git. | Take it out of git. **Important** if the repository is not private. |
| `trades.db`, `errors.db` | Old SQLite files from before Postgres. Git-ignored. | Delete after one last look. |
| `research/` (54 MB), `cache/` (213 MB) | Study data; 188 MB is Binance candles. | Delete what is no longer studied. |
| `harvester/`, `Dockerfile.harvester` | Not traced: I did not check what still uses them. | Check before touching. |

## 3. No need

| What | Why it is fine |
|---|---|
| Web bundle | Gzip is on, assets are cached for a year, the largest file is 232 kB. |
| Database memory settings | `shared_buffers` is the default 128 MB, but the cache hit rate is 99.4%. |
| Unused indexes | Nine, each 40 kB or less. |
| `/api/health`, `/api/chain` | 12 ms and 96 ms. The server itself is not blocked. |
| Session lookup on every request | A scan of an 8-row table. |
| Overview and chain board | In use on screen. |
| P&L report and `mtm_samples` | In use on screen. |
| Manual order ticket | In use on screen; shares the trading engine. |
| Tools: `app/server/src/docs/gen-docs.ts`, `app/server/src/db/import-sqlite.ts`, `app/server/src/auth/cli.ts` | Not part of the running server; still needed. |
| `app/server/src/domain/score.ts`, `calibration.ts`, `app/server/src/backtest/backtest.ts` | They look unrelated, but the signal runner imports them. Leave them. |
| `chain_features` | Small (1.5 MB), and `app/server/src/market/flow.ts` reads it. |
| Signal-path tables | `entry_signals`, `entry_setups`, `entry_methods`, `entry_gates`, `entry_alerts`, `entry_alert_log`, `entry_cleared`, `strategies`, `strategy_signal_runs`, `trades`, `trade_events`, `settings`, `errors`, `perp_snapshots`, `trade_flow_1m`, `index_1m`, `book_heat_1m`, `oi_snapshots`, `option_snapshots`. All needed. |
| The git-ignored keys file at the repo root | It is ignored, so it is not pushed. I did not open it. Just never commit it. |

## Numbers behind the audit

| Measure | Value |
|---|---|
| Database to API traffic | 730 to 925 kB a second; 24.4 GB in 14 hours |
| API process | About 25% of one CPU, 187 MB |
| Database | 439 MB on disk, 343 of 512 MB memory in use |
| Requests from one open screen | About 42 a minute, plus the live stream |
| Host | 4 CPUs, 7.7 GB; shared with the editor and its tools (about 1.4 GB) |
| Largest tables | `option_snapshots` 218 MB, `option_flow_1m` 106 MB, `option_snapshots_1m` 30 MB, `entry_signals` 21 MB, `entry_setups` 11 MB |

## Where to start

1. Decide items 1 and 2: they are about money, not speed.
2. Free disk space (item 6): quick, and no code changes.
3. Fix the two loops (items 3 to 5): this removes most of the load.
4. Install `pg_stat_statements` (item 7) at a quiet time, then measure again.
