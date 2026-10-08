# Database

What each table is for and why it is shaped that way. Column types, keys and
indexes are generated from a freshly migrated database in
[schema.md](schema.md), which is the authority where the two differ; the
design is in [decision 0008](../decisions/0008-one-database-one-schema.md).

One PostgreSQL database, `btc_desk`, holds everything the desk writes, all in
the one schema, `public`; one SQLite file, `chain.db`, holds the evidence it
reads. A table's area is its name's prefix wherever a bare name would be
ambiguous (`auth_sessions`, `strategy_runs`).

| Area | Tables | Written by | Purpose |
|---|---|---|---|
| trading | `trades`, `trade_events`, `settings`, `mtm_samples` | the trading engine, the settings cache | The trade journal and the desk's remembered choices. What makes a restart safe. |
| strategy | `strategies`, `strategy_runs`, `strategy_signal_runs` | the scheduler | Saved strategies and their run journals (what stops a strategy entering twice, or taking a signal twice). |
| sign-in | `auth_user`, `auth_sessions`, `auth_recovery_codes`, `auth_limits`, `auth_events` | the sign-in | The one user, sessions, recovery codes, rate limits, the security log. |
| broker | `broker_accounts` | the Accounts screen | Whose API key the desk trades with: the accounts, their keys sealed, and which is the default. |
| errors | `errors` | everything | Every failure, from all three tiers, in one place. |
| market | `oi_snapshots`, `chain_features`, `option_snapshots`, `option_snapshots_1m`, `trade_flow_1m`, `option_flow_1m`, `book_heat_1m`, `perp_snapshots`, `index_1m` | the chain route, the API's recorders, the perp's trade socket, and the book sampler | What open interest and at-the-money volatility *were*, so a change in either is readable. Disposable. |
| chart | none | -- | `chart_annotations` (levels saved on the price chart) was dropped on 4 Oct 2026 with the chart's layers (`chart-002-drop-annotations`); it held no rows. |
| ledger | `schema_migrations` | `db/migrate.ts` | The one ledger of what has been done to the database. |
| `chain.db` (SQLite) | 6 | the harvester, offline | Two years of settled option chains. Read-only at runtime. |

In the container the database is the `db` service (`postgres:17-alpine`) on the
`pgdata` volume, reached as `DATABASE_URL`; `chain.db` lives on the `data`
volume at `/srv/data/chain.db`. Locally, `DATABASE_URL` points wherever you
like (`deploy/test-db.sh up` gives a throwaway one) and `paths.ts` walks up to
find `chain.db` at the repository root.

---

## Why one database, and one schema

The SQLite files were separate for reasons that were each right: an order
journal must not be replaced by a market-data refresh; the sign-in must be
copyable without carrying the journal; the error log must never be written by a
test. Those are separations of *ownership and lifetime*, and in one database
they are kept by the code rather than by files: each store owns its tables and
its migrations, and nothing but the desk writes to any of them. One `pg_dump`
is the whole desk. One ledger says what shape it is in. One connection pool
means a leak shows up as exhaustion in one place.

What one database does **not** give is a separate failure mode, and that is a
feature: before, a deploy could come up with `trades.db` migrated and the
strategy tables missing, and report healthy. Now every store is migrated at
boot, in order, before `listen`, and `/api/health` lists the ledger.

Why one schema rather than a schema per area: a database console (Adminer)
shows one schema at a time, and the desk's twenty tables are few enough to read
as one list. The cost is the prefixes, and that the sign-in tables are no longer
a separate namespace to grant or revoke as a block -- `desk_ro` is denied them
table by table instead.

### Access, in code

- `db/pool.ts` — the one `pg.Pool`, from `DATABASE_URL`. `query`, `rows`, `one`,
  `tx` (one connection, BEGIN/COMMIT/ROLLBACK). `BIGINT` comes back as a number.
- `db/migrate.ts` — the ledger, below.
- `db/settings.ts` — the settings cache, below.
- Each store owns its tables' migrations and its SQL: `trading/store.ts`,
  `strategy/store.ts`, `auth/store.ts`, `observability/errors.ts`,
  `market/oi-history.ts` (+ `chain-features.ts`).

Every store is `async`. The engine awaits its journal write before it does
anything that depends on it — protection is sent only once the fill that needs
it is committed — which is the property a fire-and-forget write would have
lost. The one exception is `ErrorLog.record()`, which returns at once and
queues the write: a logger that awaits the network slows the route it is
logging, and a logger that can fail takes the thing it was logging down with it.

---

## Schema changes

`db/migrate.ts` — an ordered list, each migration with a permanent id, each
applied inside a transaction, each recorded in `public.schema_migrations` when
it succeeds. A migration that has run is skipped. A migration that fails rolls
back **and stops the boot**, because starting a trading engine against a
half-migrated database is worse than not starting. Two boots at once take an
advisory lock first, so one runs the list and the other finds it done — SQLite's
file lock did this for free; PostgreSQL has to be asked.

Two rules for anyone adding one:

- **Never edit a migration that has shipped.** It has already run somewhere.
  Editing it changes what that database has and what a fresh one gets, and the
  two diverge silently. Add another.
- **Ids are permanent.** They are the memory. Renaming one re-runs it.

Ids are `<area>-NNN-what-it-does`. The list a fresh database applies is
generated in [schema.md](schema.md#migrations-applied).

Retired migrations stay in the live ledger and are never run on a fresh
database: `market-010` to `market-012`, `market-015-signal-lifecycle-audit`,
`market-016-state-heartbeat`, `market-017`, `market-018` (the market-state and
shock journals, removed from the code on 28 Sep 2026 and their tables dropped
on 29 Sep) and `analytics-001-to-public` (the analytics service, retired 29 Sep
2026). `market-015` and `market-016` are therefore each used twice; the ledger
keys on the whole id, so neither shadows the other, and a shipped migration is
never renamed. **The next market migration is `market-019`.**

The `001`–`004` migrations still create each table in its old schema -- they
have shipped, and are never edited -- and the `*-to-public` migrations after
them move it, so a fresh database and the live one end in the same place. The
move (`moveToPublic` in `db/migrate.ts`) is catalogue-only and instant: it
renames the table where it is, then its indexes and identity sequence with it
(`runs_pkey` -> `strategy_runs_pkey`), then moves it to `public`, then drops the
old schema once it is empty. Done on the live desk at 12:00 IST, 19 Sep 2026,
after a rehearsal on a restored copy of that morning's backup.

`/api/health` reports them as `schema`, and `db: { ok, latencyMs }` beside it,
so a deploy that did not migrate — or a database that is slow — is visible
without opening a shell.

### `public.schema_migrations`

| Column | Type | |
|---|---|---|
| `id` | TEXT PK | Permanent. |
| `applied_at` | BIGINT | Epoch ms. |

---

## `trading` — the trade journal

Two tables carry the trades and one rule governs them: **events are appended and
never edited, and the state is rebuilt from them.** The process can die between
placing an order and hearing back; the journal is what makes that survivable.

### `trades` — one row per trade

| Column | Type | What it holds |
|---|---|---|
| `trade_id` | TEXT PK | `{CP}-BTC-{strike}-{expiry}-{ms}`, e.g. `C-BTC-79600-090926-1788948302789`. Also the seed for every client order id on the trade. |
| `symbol` | TEXT | The Delta contract symbol. |
| `phase` | TEXT | Where the trade is in its machinery: `precheck`, `entry_pending`, `entry_unknown`, `position_open`, `unprotected`, `protected`, `exit_pending`, `flat`, `aborted`. The first seven are what `OPEN_PHASES` in `store.ts` counts as still live. Not the same as the four order statuses the Orders screen shows — `status.ts` maps between them. |
| `position` | INTEGER | Contracts held, negative for a short. **Counted from fills, never assumed.** Written as `exit.size - entry.size` so a closed trade is `0` and never `-0`. |
| `plan` | JSONB | What was asked for: lots, leverage, entry type and limit, chase settings, `takeProfitPrice`, `stopPrice`, and the `expect` block the precheck matches the contract against. |
| `state` | JSONB | The reduced state: fills, protection client ids, phase, realised P&L, `contractValue`, `wantsProtection`. |
| `updated_at` | BIGINT | Epoch ms. Indexed (`trades_by_updated_at`), which is what the Orders date filter reads. |

> **The `plan` column is the single most expensive bug in this repo's history.**
> `save`'s upsert originally listed `phase`, `position`, `state` and
> `updated_at` — and not `plan`. So the plan was written once on insert and
> never again, and every later change to it was lost on the next read. That one
> omission produced three separate symptoms at once: exits that "would not
> update", a percentage bar seeded from a level that had not existed for an
> hour, and a panel headed "on the book now" disagreeing with Delta. Four tests
> in `store.test.ts` cover it, the first being a plan changed and read back.

### `trade_events` — the append-only log

| Column | Type | What it holds |
|---|---|---|
| `id` | BIGINT identity PK | |
| `trade_id` | TEXT | The trade. `REFERENCES trades ON DELETE CASCADE`. |
| `seq` | INTEGER | Position in that trade's sequence. `UNIQUE (trade_id, seq)` is what makes replay deterministic and a double-write impossible. |
| `at` | BIGINT | Epoch ms. |
| `kind` | TEXT | `entry_submitted`, `fill`, `entry_timeout`, `entry_cancelled`, `protection_placed`, `protection_failed`, `exit_submitted`, `reconciled`, … |
| `event` | JSONB | The whole event. |

`save()` writes the row and every event not yet written in one transaction.
`hydrate()` replays them through `recompute()`, so a correction to the
arithmetic repairs history rather than only new trades — which is how the
realised-P&L bug (a missing × contract value, showing `+$3.00` for `+₹255`) was
fixed for trades that had already closed.

### `settings`

| Column | Type | What it holds |
|---|---|---|
| `key` | TEXT PK | e.g. the default expiry. |
| `value` | TEXT | The value. |

Owned by `db/settings.ts`, which is the only reader and writer: a
**write-through cache**. The table is read once at boot into memory; `get(key)`
is synchronous, so the gates that read the mode and the cap on every order stay
synchronous; `set(key, value)` writes the row *first* and updates memory second,
so a setting the screen was told is saved, is saved. The process is the only
writer, so the cache cannot go stale. The two SQLite stores used to open this
table on two connections; this is the one copy.

Keys the desk reads:

| Key | Value | What it does |
|---|---|---|
| `expiry_default` | `first` \| `next_entry` | Which contract the board opens on. Seeded by `trading-002-default-settings`. |
| `mode` | `live` \| `paper` | Which book the desk is trading. Written by the mode switch, so a mode chosen in the browser outlives a restart. |
| `max_short_contracts` | a whole number | The most contracts the desk may be short across every strike at once. |
| `signal_max_open` | a whole number, 0-500 | The most open trades the desk may hold at once across every strategy -- positions and working orders. A signal past it is skipped. 0 or absent: no cap. |
| `alerts_enabled`, `best_trade_min_premium`, `scheduler_enabled`, `signal_max_open`, `rebalance_*`, `wall_within_em` | | The other remembered switches; each is documented where it is read. |

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

### `mtm_samples`

The day's P&L once a minute, so the day can be drawn as a line. `at` (BIGINT PK),
`day` (TEXT, IST date), `realised`, `unrealised`, `charges`, `net` (DOUBLE
PRECISION, USD). Pruned at ninety days. With the journal rather than with
`market` because it is about money that was made and lost.

---

## `strategy` — the scheduler's journal

The `runs` table is what stops a strategy entering twice. It is written
**before** the orders go out, not after: if the process dies between the write
and the fill, the day is marked spent and a human looks at it, which is the
safe direction. Marked-and-not-traded loses an opportunity; traded-and-not-marked
doubles a position.

| Table | Key | What it holds |
|---|---|---|
| `strategies` | `id` TEXT PK | `name`, `enabled` BOOLEAN, `config` JSONB, `created_at`, `updated_at`. Seeded with the three researched strategies (`baseline`, `locked`, `double`), only `double` armed; a desk that already has them keeps whatever the person has since changed. |
| `strategy_runs` | identity; `UNIQUE (strategy_id, run_date)` | One row per strategy per IST day. `claim()` is `INSERT … ON CONFLICT DO NOTHING`: the constraint decides who won, not a check-then-write. |

`strategy_adds` and `strategy_rebalances` were retired with their features on
22 Sep 2026 and **removed on 23 Sep 2026** by `strategy-005`, taking 19 rows of
add history and 25 columns with them. `strategy-004` had deliberately left them
standing -- remove first, delete later -- and this was the "later". There is no
other copy: the backup taken before that deploy is the only one.

The desk-wide strategy setting `scheduler_enabled` is in `settings`, through
the same cache. (`rebalance_limits` and `rebalance_defaults` were deleted by
`strategy-004`.)

**The Extras were retired on 22 Sep 2026** -- the safety % gate, doubling the
surviving leg, the sell-score bar, the sudden-move limit, adding to the other
leg and the rebalance. `strategy-004-retire-extras` removed their keys from
every saved config (`RETIRED_KEYS` in `strategy/store.ts`), and the store drops
them from anything read back, so a strategy reads as what it now does.

`config` is JSONB, so a new setting needs no migration -- and must read an
absent key as what older strategies were doing. Since 22 Sep 2026 it may carry
`targetMode` / `stopMode` (`pct` or `points`), `takeProfitPoints` /
`stopLossPoints`, `targetSteps` / `stopSteps` (`[{ at: "HH:MM", value }]`, each
between entry and exit) and `premium.fallbackUsd`. Since 4 Oct 2026 a signal
strategy may carry `strikeBlocks` (`[{ at: "HH:MM", strikeRule, strikeStep,
premium }]`): its strike rule over the window; absent or empty is one rule all
window. A premium rule, the strategy's or a block's, may carry `minOtm` (1-20),
the nearest strike its own pick may be, and beside it `elseOtm` (1-20), the
strike sold when the pick is nearer. Since 8 Oct 2026 a strategy, or a block,
may carry `delta` (`{ max }`, 0.01-0.50) and `distance` (`{ pct, scale }`,
`scale` `fixed` or `time`), read when `strikeRule` is `delta` or `distance`.
A signal rule may carry `minSlPts`
and `minTgtPts` (`{ "5m": 150 }`): the least distance from the perp entry to
the SL, and to the target, per timeframe; and since 5 Oct 2026 `maxSlPts` and
`maxTgtPts`, the most each may be. Each key is written only when set. Absent, they read as a
percentage all day and no fallback (`exitRules()`, `cleanConfig()`). Which stage
of a timetable a trade is on is not stored: it is a function of the clock.

---

### `trend_paper` — removed

The trend plan's forward test: dropped on 4 Oct 2026 (`strategy-007-drop-trend-paper`)
with its recorder and `GET /api/trend/paper`. No screen read it. Its 31 rows
were exported first.

## `auth` — the sign-in

One desk, one user. Only the SHA-256 of each session token is stored, so the
table cannot be replayed if it leaks — which is what makes logging out,
changing the password, and "log out other devices" actually end a session
instead of waiting for a signed cookie to expire.

| Table | What it holds |
|---|---|
| `auth_user` | A single row (`CHECK (id = 1)`): `username`, `password_hash` (scrypt), `password_changed_at`, the sealed `totp_secret` and when it was enabled, `totp_last_step` (a code's step is claimed in one conditional UPDATE, so the same code sent twice passes once), the pending secret during setup. |
| `auth_sessions` | `token_hash` PK, `stage` (`totp` \| `setup` \| `full`), `scope` (`full` \| `view`: the phone's read-only sign-in, chosen at the password step and kept to the end; `auth-003-session-scope`, 6 Oct 2026), created / expires / last seen, `ip`, `user_agent`, wrong-code `attempts`, `revoked_at`. Partial index on live rows. Pruned a week after a session *ended*. |
| `auth_recovery_codes` | `code_hash` PK, `used_at`. Spent once, ever. |
| `auth_limits` | `key` PK, `count`, `window_until`. The sign-in rate limits, per address and per account. |
| `auth_events` | identity, `at`, `kind`, `ip`, `detail`. The security log; kept 180 days. |

The sealed secret opens only under the `DESK_SESSION_SECRET` it was sealed with;
a dump of these tables on their own opens nothing.

---

## `broker_accounts` — whose key the desk signs with

Until 5 Oct 2026 the Delta API key was two lines of `.env`: one account, changed
by editing a file and restarting a desk that may be holding positions. Now each
account is a row, kept from the screen (Logs -> Accounts), and the desk trades
on the one marked default. `delta/accounts.ts` owns the table.

| Column | Type | What it holds |
|---|---|---|
| `id` | BIGINT identity PK | |
| `name`, `description` | TEXT | What the person calls it. `name` is unique, whatever its case. |
| `broker` | TEXT | `delta-india`, the only one. |
| `api_key_sealed`, `api_secret_sealed` | TEXT | **Both sealed**: AES-256-GCM under a key derived from `DESK_SESSION_SECRET` (label `btc-desk/broker-account/v1`, a key of its own -- the sign-in's sealing key does not open it). A dump of this table signs nothing. |
| `key_hint` | TEXT | The key's last four characters: all the screen is ever given. |
| `active` | BOOLEAN | Off, the account is kept and cannot be the default (`CHECK (active OR NOT is_default)`). |
| `is_default` | BOOLEAN | The account the desk trades on. A partial unique index allows one. |
| `created_at`, `updated_at` | BIGINT | Epoch ms. |
| `last_test_at`, `last_test_ok`, `last_test_detail` | | What the last connection test said -- one signed read of the wallet. |

Read like `settings`: the table is loaded into memory once at start, the process
is its only writer, and every change is written first and memory updated
second, so a signed request never waits on the database. It is read again once
a day, for a row changed by hand in a console; a default changed that way is
followed only when no live position is open.

Rules the routes hold (`http/routes/accounts.routes.ts`), each answered through
`refuse()`:

- **The account under a live position does not change.** Choosing another
  default is refused while the desk is live with anything open; removing or
  switching off the default is refused while the desk is live at all. The mode
  switch's rule, for the mode switch's reason.
- **A default has to work now.** Its connection is tested before the switch; a
  key that fails is not made the default, and the row says what Delta said.
- **A row that will not open is never used.** After `DESK_SESSION_SECRET` is
  rotated an account shows "key unreadable"; it is added again as a new account
  and the old row removed.
- **Removing takes a fresh authenticator code.** A signed-in browser may look
  and switch; destroying a key is not undone by signing in again, so
  `POST /api/accounts/:id/remove` asks the second factor the way a new set of
  recovery codes does -- the same lockout, a code good once -- and the removal,
  and a refused attempt, are in `auth_events` and on the phone.
- **An account with history is kept.** One that has trades or strategies on
  record (`broker_account_id`, below) is switched off, not removed: its orders,
  P&L and strategies are read by its id. `GET /api/accounts` says why each
  account cannot be removed, so the screen says it before a code is asked for.
- **The last account is never removed, only switched off.** A desk that has had
  an account always has one to switch back on; switched on with no default
  anywhere, it is the default again. A key is replaced by adding the new one
  first and removing the old second.

`.env`'s `DELTA_API_KEY` / `DELTA_API_SECRET` are read once: the first start
with no account imports them as the default (the setting `broker_env_imported`
remembers it, so a table emptied by hand is not refilled), which is what lets a
desk holding live positions come up on the account it went down on. The key is
not kept in `.env` after that: the desk says at start, and on the Accounts
screen, that the two lines are still set, until they are emptied.

### `broker_account_id` — what belongs to which account

Since 5 Oct 2026 three tables carry the account, so Strategy, Positions, Orders
and P&L can be read one account at a time (the tabs over those screens; routes
take `?account=<id>`, and without it answer for every account as before):

| Table | Column | Written |
|---|---|---|
| `trades` | `broker_account_id` (indexed with `updated_at`) | Once, with the row, from `plan.accountId`: the account the desk was on when the trade was placed. Never changed. |
| `mtm_samples` | `broker_account_id` | With each reading: the account the desk was on. |
| `strategies` | `broker_account_id` | When the strategy is made: the account whose tab it was made on. A saved strategy keeps it. |

`trading-007-broker-account` and `strategy-008-broker-account` gave every row
that existed the one account the desk had. No foreign key -- the journal is
migrated in places the accounts table is not -- and the rule a key would hold
(no row left belonging to nothing) is held by not removing an account that has
any.

**What is per account, and what is the desk's.** Checked across the code on
5 Oct 2026:

| | Kept | Per account? |
|---|---|---|
| strategies, their runs and signal runs | `strategies.broker_account_id`; the runs by their strategy | yes |
| orders, positions, the P&L calendar | `trades.broker_account_id` | yes |
| the day's P&L line | `mtm_samples.broker_account_id` | yes |
| today's booked P&L -- the daily-loss gate, the day's summary | each desk's own scoped journal | yes: each account's own |
| "At most open" over a set of strategies | `settings` `signal_max_open@<id>` | yes |
| the most lots short | `settings` `max_short_contracts@<id>` | yes |
| the wallet, margin and positions on a screen | Delta, as the account being shown | yes: the shown account's own desk (blank for one that is switched off) |
| paper or live, the scheduler switch, the alerts switch | `settings` `mode`, `scheduler_enabled`, `alerts_enabled` | no: one desk, one switch |
| entry signals, setups, gates, methods; market data | `entry_*`, the market tables | no: they are the market's, not an account's |
| sign-in, the error log, the Telegram log | `auth_*`, `errors`, `telegram_log` | no: the desk's |

The two per-account settings are read through `accountSetting` (`db/settings.ts`): an account with no value
of its own takes the desk-wide one, so a limit set before there were accounts still holds.

**Every active account trades at once, each on a desk of its own** (since the
evening of 5 Oct 2026; `trading/service.ts`). A desk is one account's
`TradingService`: its own exchange signed with its own key, its own engine and
poll loop, its own balance, limits and caches. Each is handed the journal
through `PgTradeStore.scoped(accountId)`, which can read and write only that
account's trades -- the wall that keeps one account's engine from stepping, or
"finding closed", another account's position. A strategy runs on its own
account's desk; a request is answered by the desk of the account it names, or of
the trade it acts on (`deskOfRequest`); with neither, the default account's.
**The default is only which account's tab opens first.** Switching an account
off stops its desk (refused while it holds a position); with no account
switched on there is the one paper desk over the whole journal, as before
there were accounts. `mtm_samples` is keyed by moment and account
(`trading-008-mtm-by-account`), since two desks can take a reading in the same
millisecond.

---

## `errors` — every failure, one table

A trading desk fails in three places, and they are normally three separate
investigations: a route throwing on the server, a component throwing in the
browser, and the exchange refusing something in between. Splitting those across
a container log, a browser console nobody has open, and a swallowed
`.catch(() => null)` is how a bug survives for a week. They all land here, in
one shape, in time order.

| Column | Type | What it holds |
|---|---|---|
| `id` | BIGINT identity PK | |
| `fingerprint` | TEXT UNIQUE | `source + code + where + message`, joined with the ASCII unit separator, truncated to 512. Deliberately **not** the stack: the same bug reached from two call sites is one bug, and folding on the message keeps the list short enough to read. |
| `source` | TEXT | `server` \| `browser` \| `exchange` \| `trading`. |
| `level` | TEXT | `error` \| `warn`. |
| `message` | TEXT | One line, trimmed to 500. |
| `code` | TEXT | An HTTP status, a Delta error code, or `network`. |
| `stack` | TEXT | Trimmed to 4,000; the newest is kept, being the most likely to still be reachable. |
| `where_at` | TEXT | A route, a component, a symbol. For browser network failures this is the **path without its query string** — using the whole URL made a separate row for every combination of chain parameters anyone had ever looked at. |
| `context` | JSONB | Anything that helps reproduce it, **passed through `redact()` first**. |
| `first_seen` / `last_seen` | BIGINT | Epoch ms. |
| `count` | INTEGER | Identical failures fold into one row, so a poll failing every second cannot bury everything else. |
| `resolved` | BOOLEAN | Hidden by default; `remove()` deletes for good. |

Indexes: `errors_log_by_time (last_seen DESC)`, `errors_log_by_source (source, last_seen DESC)`.

Capped at 2,000 rows, pruned every fiftieth write. Pruning takes the **oldest
resolved rows first** — an unresolved failure is never dropped to make room for
a newer one. `errors.test.ts` pins it.

> The SQLite fingerprint was joined with a NUL byte, which the driver cut the
> string at on the way in: every stored fingerprint was its first part, the
> source, and only the UNIQUE constraint's view of the raw bytes kept the rows
> apart. The import rebuilt every fingerprint from its parts with today's
> separator, so a repeat after the cutover folds into the imported row.

Three properties this table is built around:

- **Nothing but the desk writes to it.** The test suite used to: four test files
  pointed `ERROR_DB` at a temp path and every other file that made the exchange
  refuse an order filed that refusal here. Two rows with 72 folded occurrences
  between them — `insufficient_margin` and `unsupported` on `POST /v2/orders` —
  turned out to be fixtures with a `node:assert` stack. `test/env.ts` now gives
  every test process a `btc_test_*` database of its own and drops it afterwards;
  `env.test.ts` fails if `DATABASE_URL` names anything else.
- **`record()` never throws, and never waits.** A logger that can fail takes down
  the thing it was logging; a logger that awaits the network slows it. The write
  is queued and runs in the background, one after another, so two reports of the
  same failure fold in the order they happened; `flush()` waits for the queue.
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

## `market` — what the board looked like a while ago

`oi_snapshots`: `(at, expiry, cp, strike)` primary key, carrying `oi`,
`spot` and `atm_iv` (nullable: the rows written before the column existed have
no value, and inventing one would put a made-up volatility into the history a
shock is measured against). Five-minute buckets, forty-eight hours kept, pruned
as it writes. The writer is throttled by asking the table, not a variable.

`chain_features`: the whole board every five minutes — the straddle, the
skew, put/call volume and OI, the walls, max pain, the hour's OI change — so the
chain can one day be measured the way the candles were. Kept 400 days.

`option_snapshots` (`market/option-snapshots.ts`): `(at, symbol)` primary key,
`(symbol, at)` index. Every strike of the two nearest live expiries, every five
minutes — mark, last, bid, ask, sizes, mark / bid / ask IV, the five greeks, OI,
volume and spot. Written by a timer in `index.ts` (checked each minute, one
bucket per five, `ON CONFLICT DO NOTHING` so a restart cannot double a bucket)
in one batched `unnest` insert; rows older than 365 days pruned as it writes.
Created directly in `public` by `market-004-option-snapshots`.

`index_1m` (`market/index-1m.ts`, migration `market-013`): BTC, once a minute,
and nothing else. Every other recorder keeps a *reading* and carries the price
as a column at its own cadence, so "what did BTC do between 13:18 and 13:33"
needed a round trip to Delta and a signal's points moved could not be checked
after the fact at all. The minute is the primary key, so a restart, a double
timer or a replayed snapshot cannot write it twice, and a minute with no price
is left as a hole rather than filled with the last one -- inventing a tick that
never happened is worse than a gap. Kept a year: half a million rows of three
numbers. `moveOver()` gives the points and percent between two moments **with
the minutes it actually covered**, because a move measured over 40 minutes of
an hour is a different figure from one measured over the hour.

`large_prints` -- every large taker order on its own row -- was dropped on
4 Oct 2026 (`market-017-drop-large-prints`): the chart's big-trade bubbles read
it, they were removed, and nothing else did. Its rows were exported first. The
minute rows above still count the large trades, each side.

`book_heat_1m` (`market/book-heat.ts`, migration `market-016-book-heat`): the
perpetual's order book, read from REST every ten seconds (500 levels a side,
about ±1.2% of price) and written a minute at a time: `base` (the lowest $10
bin's price), `step` (10), `bid` and `ask` as `REAL[]` of the minute's average
contracts per bin from `base` up, `samples`, and the touch (`best_bid`,
`best_ask`). `PRIMARY KEY (at)`, `ON CONFLICT DO NOTHING`. Read by
the entry methods, for the book and its persistent walls (the chart's heatmap, which also read it, went on 4 Oct 2026). About
1 KB a row, 1,440 a day; kept 14 days (~20 MB).

`trade_flow_1m`, `perp_snapshots` (`market/flow.ts`, migration
`market-005-flow`): the perpetual's tape summed per minute by
aggressor side (volume and, since `market-006`, the count of large prints), written every twenty seconds from the prints the
`all_trades` socket (`market/flow-socket.ts`) holds in memory, `ON CONFLICT DO
NOTHING` so a replayed snapshot cannot double a bar; the perp ticker and the
top of its book every five minutes. Both kept a year. `market-005` created a
third here, `iv_term_snapshots` (ATM IV per listed expiry); it fed the IV term
structure card alone, and went with it on 23 Sep 2026 (`market-009`). The hour's flow is read from the table plus the
minute in progress, and says how many minutes it has -- a socket outage shows
as a short window, never as zero flow.

Kept apart from the journal for the reason the journal is kept apart, in reverse: this is
market data and entirely disposable. Truncate it and the board loses its change
columns until the next bucket. Nothing else notices.

---

### The option record, at two grains (22 Sep 2026)

`option_snapshots` holds every strike of the two nearest expiries every **five
minutes**, and `option_snapshots_1m` the same rows every **minute**. Measured on
the live desk: ~350 bytes a row, 161 strikes a bucket.

| Table | Grain | Kept | Size | Answers |
|---|---|---|---|---|
| `option_snapshots` | 5 minutes | 90 days | ~16 MB a day, ~1.4 GB at 90 days | the hour-ago and day-ago reads, ΔOI, IV change |
| `option_snapshots_1m` | 1 minute | 6 hours | ~20 MB, rolling | the 1-minute window and the premium's velocity |

Why two: a minute grain kept like the other would be ~30 GB a year, which this
disk does not have; a five-minute grain alone cannot answer "what has this
premium done in the last minute" -- the 1m row on *What changed* was dashes, and
a window under five minutes read against the bucket "now" comes from would say
"nothing changed", which is worse than a dash. Neither costs an extra request:
the recorder wakes every minute and skips the five-minute write when its bucket
exists. The retention was a year until 22 Sep 2026; at ~16 MB a day that reaches
~5.9 GB, against 12 GB free.

The freshness bar's "OI record" reads the newest of the two, so it moves every
minute; `/api/health` still reports the five-minute bucket.

---

## `chart_annotations` — dropped

Levels saved on the price chart, one of its layers. The layers were removed on
4 Oct 2026 and the table with them (`chart-002-drop-annotations`, in
`market/flow.ts`); it held no rows on the desk. `chart-001-annotations`, which
made it, is retired: it stays in the live ledger and is not run on a fresh
database.

---

## Retired tables

Dropped on 29 Sep 2026 at 08:07 UTC, after the backup
`backups/btc_desk-20260929-0807.dump`, which holds them with their data:
`market_states`, `market_state_checks`, `shock_snapshots` (the market-state and
shock journals) and `outlook_states`, `chain_states`, `analytics_publish_meta`
(the retired analytics service). `strategy_adds` and `strategy_rebalances` went
on 23 Sep 2026 (`strategy-005`), `iv_term_snapshots` on 23 Sep (`market-009`).
Their descriptions are in [history/2026-09.md](../history/2026-09.md).

## `chain.db` — the evidence

The one SQLite file. Built offline by `harvester/`, shipped to the desk by
`deploy/refresh.sh` as a SQLite backup rather than a file copy, so a half-written
WAL is never shipped. Read-only at runtime, opened by `backtest.ts`,
`domain/forecast.ts` and `domain/calibration.ts` — and by the harvester and
the research scripts with `sqlite3`, which is why it
stayed a file when everything else moved. **735 days, 2024-09-04 to 2026-09-08** --
and stuck there: the daily refresh has been writing to the wrong file since
8 Sep ([TODO.md](../TODO.md), "The desk's dataset stopped on 8 Sep").

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


---

## The move from SQLite, 19 September 2026

`app/server/src/db/import-sqlite.ts` (`npm run db:import -- --data-dir /srv/data`)
copies `trades.db`, `auth.db`, `errors.db`, `market.db` and `analytics.db` into
the tables above: each table in its own transaction, every row
`ON CONFLICT DO NOTHING`, so it can be run again and copies only what is missing;
ids carried over and the identity sequences moved past them; a count of every
table on both sides at the end, and a non-zero exit if any pair differs. The
SQLite files are opened read-only and stay on the volume as the rollback path.
`test/db/import-sqlite.test.ts` runs it against files written in the old schema.
The cutover is recorded in [history/2026-09.md](../history/2026-09.md), 19 Sep 2026.

Type mapping, for anyone reading an old row description: epoch-ms `INTEGER` →
`BIGINT`; JSON in `TEXT` → `JSONB`; `REAL` → `DOUBLE PRECISION`; 0/1 flags →
`BOOLEAN`; `AUTOINCREMENT` → identity. `premium_alerts`, a table nothing read
and nothing had written, was not carried.
