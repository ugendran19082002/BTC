# Database inventory

Three SQLite databases, each with one job. Every table and column below, what
it holds, and why it is shaped that way.

Row counts were read from the live desk on 9 September 2026.

| Database | Written by | Tables | Purpose |
|---|---|---:|---|
| `chain.db` | the harvester, offline | 6 | Two years of settled option chains. The evidence every number in `domain/` rests on. Read-only at runtime. |
| `trades.db` | the trading engine | 4 | The trade journal. What makes a restart safe. |
| `errors.db` | everything | 2 | Every failure, from all three tiers, in one place. |

In the container all three live in `/srv/data/`. Locally, `paths.ts` walks up to
find the repo root; `DATA_DIR` is derived from `CHAIN_DB` when it is set, so a
container never resolves the other two to a read-only path — which it did once,
and the deploy came up unhealthy.

All three are opened `PRAGMA journal_mode = WAL`.

---

## Schema changes

`db/migrate.ts` — an ordered list, each migration with a permanent id, each
applied inside a transaction, each recorded in a `migrations` table when it
succeeds. A migration that has run is skipped. A migration that fails rolls back
**and stops the boot**, because starting a trading engine against a
half-migrated database is worse than not starting.

Two rules for anyone adding one:

- **Never edit a migration that has shipped.** It has already run somewhere.
  Editing it changes what that database has and what a fresh one gets, and the
  two diverge silently. Add another.
- **Ids are permanent.** They are the memory. Renaming one re-runs it.

Applied on the live desk today:

| Database | Migrations |
|---|---|
| `trades.db` | `001-trades`, `002-trades-by-updated-at`, `003-default-settings` |
| `errors.db` | `001-errors` |

`/api/health` reports the trade schema, so a deploy that did not migrate is
visible without opening a shell.

---

## `trades.db` — the trade journal

Two tables carry the trades and one rule governs them: **events are appended and
never edited, and the state is rebuilt from them.** The process can die between
placing an order and hearing back; the journal is what makes that survivable.

### `trades` — one row per trade, 24 rows

| Column | Type | What it holds |
|---|---|---|
| `trade_id` | TEXT PK | `{CP}-BTC-{strike}-{expiry}-{ms}`, e.g. `C-BTC-79600-090926-1788948302789`. Also the seed for every client order id on the trade. |
| `symbol` | TEXT | The Delta contract symbol. |
| `phase` | TEXT | Where the trade is in its machinery: `precheck`, `entry_pending`, `entry_unknown`, `position_open`, `unprotected`, `protected`, `exit_pending`, `flat`, `aborted`. The first seven are what `OPEN_PHASES` in `store.ts` counts as still live. Not the same as the four order statuses the Orders screen shows — `status.ts` maps between them. |
| `position` | INTEGER | Contracts held, negative for a short. **Counted from fills, never assumed.** Written as `exit.size - entry.size` so a closed trade is `0` and never `-0`. |
| `plan` | TEXT (JSON) | What was asked for: lots, leverage, entry type and limit, chase settings, `takeProfitPrice`, `stopPrice`, and the `expect` block the precheck matches the contract against. |
| `state` | TEXT (JSON) | The reduced state: fills, protection client ids, phase, realised P&L, `contractValue`, `wantsProtection`. |
| `updated_at` | INTEGER | Epoch ms. Indexed by `002-trades-by-updated-at`, which is what the Orders date filter reads. |

> **The `plan` column is the single most expensive bug in this repo's history.**
> `save`'s upsert originally listed `phase`, `position`, `state` and
> `updated_at` — and not `plan`. So the plan was written once on insert and
> never again, and every later change to it was lost on the next read. That one
> omission produced three separate symptoms at once: exits that "would not
> update", a percentage bar seeded from a level that had not existed for an
> hour, and a panel headed "on the book now" disagreeing with Delta. Four tests
> in `store.test.ts` cover it, the first being a plan changed and read back.

### `trade_events` — the append-only log, 184 rows

| Column | Type | What it holds |
|---|---|---|
| `id` | INTEGER PK | Autoincrement. |
| `trade_id` | TEXT | The trade. |
| `seq` | INTEGER | Position in that trade's sequence. `UNIQUE (trade_id, seq)` is what makes replay deterministic and a double-write impossible. |
| `at` | INTEGER | Epoch ms. |
| `kind` | TEXT | `entry_submitted`, `fill`, `entry_timeout`, `entry_cancelled`, `protection_placed`, `protection_failed`, `exit_submitted`, `reconciled`, … |
| `event` | TEXT (JSON) | The whole event. |

`hydrate()` replays these through `recompute()`, so a correction to the
arithmetic repairs history rather than only new trades — which is how the
realised-P&L bug (a missing × contract value, showing `+$3.00` for `+₹255`) was
fixed for trades that had already closed.

### `settings` — 2 rows

| Column | Type | What it holds |
|---|---|---|
| `key` | TEXT PK | e.g. the default expiry. |
| `value` | TEXT | The value. |

Seeded by `003-default-settings`.

Keys the desk reads:

| Key | Value | What it does |
|---|---|---|
| `expiry_default` | `first` \| `next_entry` | Which contract the board opens on. |
| `mode` | `live` \| `paper` | Which book the desk is trading. Written by the mode switch, so a mode chosen in the browser outlives a restart. |
| `max_short_contracts` | a whole number | The most contracts the desk may be short across every strike at once. |

`max_short_contracts` is the one setting with a **ceiling**. `/api/settings`
takes it, but `TradingService.setShortCap` decides: the cap may be lowered
freely and can never be raised above what the account's margin could carry at
200x. The reasoning is the same as `maxDailyLossUsd`'s — a cap larger than the
margin behind it can never fire, and a gate that cannot fire is worse than no
gate, because it reads as protection. A request above the ceiling comes back
`422` through `refuse()`, so holding the line does not fill the error log.

Absent, the cap falls back to `DEFAULT_LIMITS.maxShortContracts`. It is read at
the moment each gate runs, so a change takes effect on the next order rather
than at the next restart.

### `migrations`

| Column | Type | |
|---|---|---|
| `id` | TEXT PK | Permanent. |
| `applied_at` | INTEGER | Epoch ms. |

---

## `errors.db` — every failure, one table

A trading desk fails in three places, and they are normally three separate
investigations: a route throwing on the server, a component throwing in the
browser, and the exchange refusing something in between. Splitting those across
a container log, a browser console nobody has open, and a swallowed
`.catch(() => null)` is how a bug survives for a week. They all land here, in
one shape, in time order.

### `errors` — 2 rows

| Column | Type | What it holds |
|---|---|---|
| `id` | INTEGER PK | Autoincrement. |
| `fingerprint` | TEXT UNIQUE | `source + code + where + message`, truncated to 512. Deliberately **not** the stack: the same bug reached from two call sites is one bug, and folding on the message keeps the list short enough to read. |
| `source` | TEXT | `server` \| `browser` \| `exchange` \| `trading`. |
| `level` | TEXT | `error` \| `warn`. |
| `message` | TEXT | One line, trimmed to 500. |
| `code` | TEXT | An HTTP status, a Delta error code, or `network`. |
| `stack` | TEXT | Trimmed to 4,000; the newest is kept, being the most likely to still be reachable. |
| `where_at` | TEXT | A route, a component, a symbol. For browser network failures this is the **path without its query string** — using the whole URL made a separate row for every combination of chain parameters anyone had ever looked at. |
| `context` | TEXT (JSON) | Anything that helps reproduce it, **passed through `redact()` first**. |
| `first_seen` / `last_seen` | INTEGER | Epoch ms. |
| `count` | INTEGER | Identical failures fold into one row, so a poll failing every second cannot bury everything else. |
| `resolved` | INTEGER | 0 or 1. Hidden by default; `remove()` deletes for good. |

Indexes: `errors_by_time (last_seen DESC)`, `errors_by_source (source, last_seen DESC)`.

Capped at 2,000 rows. Pruning takes the **oldest resolved rows first** — an
unresolved failure is never dropped to make room for a newer one.

Two properties this table is built around:

- **`record()` never throws.** A logger that can fail takes down the thing it
  was logging.
- **Credentials never reach it.** `redact()` walks the context and replaces any
  key matching `api_key|secret|signature|password|token|cookie|authorization`.
  An error context is the classic place a key leaks: a failed request gets
  logged with its own headers attached, and now the secret is in a database
  easier to read than the environment it came from.

### What deliberately stays *out*

The log is only worth reading if everything in it needs fixing, and this desk
says no for a living. `http/refuse.ts` decides:

| Not logged | Why |
|---|---|
| any 2xx/3xx | nothing happened |
| 401, 404 | a browser reaches both by ordinary navigation |
| a 4xx marked by `refuse()` | a gate turning an order down (422) or the mode switch holding the line with a position open (409) is the desk working |
| a single browser fetch failure | one is a blip — a phone changing cell, or this server restarting under a deploy. Three in a row is an outage, and that is logged |

Everything unmarked is still recorded, **including a 400** — our own screen
posting without a `tradeId` is a bug in our own screen, and the log is the only
place anyone would find out. The default is on the safe side: forgetting to call
`refuse()` makes the log noisier, not blinder.

---

## `chain.db` — the evidence

Built offline by `harvester/`, shipped to the desk by `deploy/refresh.sh` as a
SQLite backup rather than a file copy, so a half-written WAL is never shipped.
Read-only at runtime. **735 days, 2024-09-04 to 2026-09-08.**

### `days` — one row per expiry day, 735 rows

| Column | Type | What it holds |
|---|---|---|
| `date` | TEXT PK | `YYYY-MM-DD`. |
| `v` | INTEGER | Harvester schema version of the row. |
| `spot` | REAL | BTC at 05:30 IST, when the strategy enters. |
| `settle` | REAL | BTC at the 12:00 UTC settlement. |
| `atm` | INTEGER | The at-the-money strike. |
| `step` | INTEGER | Strike spacing that day. |
| `harvested_at` | TEXT | When it was captured. |

### `legs` — every strike on every day, 27,444 rows

| Column | Type | What it holds |
|---|---|---|
| `date`, `cp`, `k` | | PK. `cp` is `C` or `P` (checked); `k` is the strike. |
| `off` | INTEGER | Distance from ATM in strikes — the axis most of the studies group on. |
| `ltp`, `mark` | REAL | Last traded and mark at entry. |
| `age_min` | INTEGER | How stale the last trade was. A cheap premium with a two-hour-old print is not a real price. |
| `vol_8h` | REAL | Volume over the previous 8 hours. |
| `settle_value` | REAL | **What the leg was actually worth at settlement.** The answer column: every win-rate figure in `domain/` is counted from this. |

`FOREIGN KEY (date) REFERENCES days(date) ON DELETE CASCADE`.

### `paths` — what happened *between* entry and settlement, 1,466 rows

Settlement alone cannot answer "would the stop have been hit". These rows can.

| Column | Type | What it holds |
|---|---|---|
| `date`, `cp`, `floor` | | PK. `floor` is the premium floor the leg was selected under. |
| `k` | INTEGER | The strike. |
| `entry` | REAL | Mark at entry. |
| `low`, `low_min` | REAL, INTEGER | The lowest mark, and the minute it happened. |
| `high`, `high_min` | REAL, INTEGER | The highest, and when — this is what a stop would have been hit by. |
| `hourly` | TEXT (JSON) | 13 marks, hour 0 to 12. |
| `decay` | TEXT (JSON) | `{fraction: first minute reached, or null}` — how quickly it fell to each fraction of entry. |
| `spike` | TEXT (JSON) | `{multiple: first minute reached, or null}` — the same, upward. |

### `calibration` — model against reality, 31 rows

| Column | Type | What it holds |
|---|---|---|
| `kind`, `bucket_lo` | | PK. `kind` is `model_potm` or `em_distance`. |
| `bucket_hi` | REAL | Upper edge. |
| `legs` | INTEGER | How many legs fell in the bucket. |
| `expired_0` | INTEGER | How many expired worthless. |
| `rate` | REAL | The share that did — what `domain/calibration.ts` corrects the model's probability toward. |
| `avg_mark` | REAL | Average mark in the bucket. |

### `oi` — open interest, 1,449 rows

Harvested separately so OI could be *tested* as a signal rather than assumed
into the strategy.

| Column | Type | What it holds |
|---|---|---|
| `date`, `cp`, `floor` | | PK. |
| `k` | INTEGER | Strike. |
| `oi_entry` | REAL | OI at entry. |
| `oi_8h_ago` | REAL | OI 8 hours earlier. |
| `oi_change` | REAL | Entry minus 8h earlier. |
| `oi_accel` | REAL | Last 2h change minus the 2h before it. |

### `horizons` — how BTC actually moves, 8 rows

One row per horizon (5m, 15m, 1h, 2h, 3h, 4h, 6h, 12h), measured over 105,120
five-minute windows. The desk reads this at runtime rather than assuming a
distribution.

| Column | Type | What it holds |
|---|---|---|
| `minutes` | INTEGER PK | The horizon. |
| `label` | TEXT | How it is written on screen. |
| `windows` | INTEGER | Sample size. |
| `move_median`, `move_p68`, `move_p95`, `move_worst` | REAL | Close-to-close move, percent. |
| `range_median`, `range_p68`, `range_p95` | REAL | High-to-low *inside* the window — what actually threatens a stop. |
| `p_up` | REAL | Share of windows that closed higher. |
| `p_up_trend` | REAL | The same, restricted to a rising trend. |
| `quantiles` | TEXT (JSON) | **101 percentiles of the signed return**, so an option's expected payout is worked out against what BTC actually did rather than against a lognormal. |
| `measured_at`, `sample_days` | TEXT, INTEGER | Provenance. |
