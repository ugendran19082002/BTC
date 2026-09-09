# File inventory

Every source file in the project, what it is for, and how big it is. Written to
be read cold: someone opening this repo for the first time — or the same person
six months later — should be able to find the file they need without opening
twenty to look.

Counts are lines, taken on 9 September 2026.

| Area | Files | Lines |
|---|---:|---:|
| `app/server/src` — API, engine, domain | 47 | 8,151 |
| `app/server/test` — server tests | 12 | 3,045 |
| `app/web/src` — the screen | 62 | 9,190 |
| `harvester` — daily chain capture | 2 | 289 |
| `research` — the studies behind the strategy | 17 | 2,638 |
| **Total** | **137** | **23,348** |

Tests are 4,770 lines of that, about a fifth. That ratio is deliberate: this is
software that can lose money by being subtly wrong, and nearly every test in
here exists because something specific went wrong once.

---

## `app/server/src` — the API and the trading engine

### Trading (`trading/`) — the part that can lose money

| File | Lines | What it is for |
|---|---:|---|
| `engine.ts` | 1,047 | **The thing that actually trades.** Owns no clock and starts no timers: time arrives as `now()` and work arrives as `poll()`. Places entries, walks a resting limit toward the bid (`chasePrice`), reconciles protection against the book, watches the exit levels against the mark (`takeProfitIfReached`), closes, and serialises everything per trade through a promise-chain mutex so two screen actions can never interleave. |
| `service.ts` | 424 | The one live trading service. Decides *which* exchange the engine drives — live requires `DELTA_LIVE_TRADING` on **and** credentials present — and owns the paper/live switch, which is server-authoritative and refuses to flip with a position open. |
| `exchange/delta.ts` | 383 | **The only file in the project that can move money.** Builds the exact order body Delta accepts, signs it, and maps replies back. Works hardest at one distinction: "Delta said no" versus "we never found out". |
| `exchange/paper.ts` | 312 | An exchange you can lie to. The simulator the whole test matrix runs against. *Read the warning in ARCHITECTURE.md before trusting it about venue semantics — it once agreed with a bug that cost real money.* |
| `exchange/port.ts` | 73 | Everything the engine is allowed to do to an exchange, and nothing more. The engine is written once against this interface; live and paper are two implementations. |
| `precheck.ts` | 293 | The gates a trade passes before a byte goes to the exchange. Each one exists because of a specific way money is lost: a stale quote, a spread too wide to cross, a premium too small to be worth the same margin, a daily loss already taken. |
| `machine.ts` | 231 | The trade lifecycle as a pure reducer over fills. Position is *counted from fills*, never assumed. No I/O, so every case in the matrix can be built by hand. |
| `types.ts` | 217 | The vocabulary of a live trade. All data, no behaviour. |
| `store.ts` | 207 | The trade journal: events appended and never edited, state rebuilt from them. What makes a restart safe. |
| `margin.ts` | 199 | What leverage actually does to a sold option — calibrated against a real Delta ticket, not against the docs. Also liquidation price and unrealised P&L. |
| `status.ts` | 80 | What a trade looks like in a list of orders: completed / pending / rejected / cancelled, and the IST day boundaries the Orders screen filters on. |
| `money.ts` | 55 | Prices and sizes the exchange will actually accept. Everything in whole ticks; a seller rounds up and a buyer rounds down, so rounding never quietly moves against you. |

### Domain (`domain/`) — what to sell and how likely it is to work

| File | Lines | What it is for |
|---|---:|---|
| `score.ts` | 512 | Ranking and sizing. `sellScore` ranks candidates; none of it predicts direction with certainty and it says so. |
| `recommend.ts` | 508 | What to sell, which side, how many lots. Both rules were measured on the 733 settled days in `chain.db`. |
| `calibration.ts` | 192 | What the model says against what actually happened — Black-Scholes' OTM probability corrected by the observed rate in the buckets around it. |
| `forecast.ts` | 184 | How far BTC could move over the next few hours, and which way. Measured over 105,120 five-minute windows. The card says plainly which half is knowable. |
| `probability.ts` | 153 | The three different questions people mean by "will it expire at zero", kept apart because they have different answers. |
| `structure.ts` | 112 | What the option board itself is saying — where open interest and gamma sit. Description only; not wired into the recommendation. |
| `bs.ts` | 82 | Black-Scholes. |

### Market data (`market/`, `delta/`)

| File | Lines | What it is for |
|---|---:|---|
| `market/chain.ts` | 453 | Builds the option chain: strike spacing read from what Delta actually lists rather than assumed, with a fallback. |
| `market/moves.ts` | 275 | A multi-timeframe read of BTC from public candles. |
| `market/delta.ts` | 201 | Delta's *public* endpoints. No API key is ever used in this file. |
| `delta/signed.ts` | 154 | Signed transport for the user's own account. One place signs, one place times out, one place decides what an error means. |

### HTTP (`http/`)

| File | Lines | What it is for |
|---|---:|---|
| `routes/trade.routes.ts` | 438 | The order desk: place, preview, close, close-all, cancel, protection, reconcile, history, mode, status. |
| `routes/desk.routes.ts` | 194 | Chain, spot, expiries, sizing, calibration, presets, settings. |
| `routes/errors.routes.ts` | 81 | The error log, readable and writable from the browser. Anything arriving over HTTP is treated as a browser report whatever it claims to be. |
| `app.ts` | 83 | Builds the Fastify app: CORS, the session gate, and the two hooks that put every failure in the log. |
| `session.ts` | 130 | Password login for a desk on the open internet. The password is never stored, sent back, or logged. |
| `refuse.ts` | 53 | An answer of "no", said deliberately — so a gate turning an order down does not look like a fault. `worthLogging` is the whole rule, in one testable function. |
| `routes/session.routes.ts` | 48 | Login, logout, me. |
| `routes/backtest.routes.ts` | 38 | Backtest over the harvested days. |

### Plumbing

| File | Lines | What it is for |
|---|---:|---|
| `backtest/backtest.ts` | 278 | Backtest over `chain.db`: open at 05:30 IST, hold to the 12:00 UTC settlement. |
| `observability/errors.ts` | 241 | Every failure this system has, in one table — server, browser, exchange, trading. Folded by fingerprint, redacted before write, and never throws. |
| `db/migrate.ts` | 83 | Schema changes that run once and are remembered. A failure rolls back and stops the boot. |
| `index.ts` | 56 | Start the desk. Composition only. |
| `paths.ts` | 41 | Where the data lives, resolved once by walking up to a repo marker. |
| `config.ts` | 40 | Every environment variable this process reads, in one place. |

---

## `app/web/src` — the screen

### Trading UI (`components/trade/`)

| File | Lines | What it is for |
|---|---:|---|
| `OrderTicket.tsx` | 751 | The order ticket. Built around one idea: you should know whether the order will be *filled* before you send it. Three price modes, live quote, chase, leverage, exit bars, and refusals shown above the button rather than after it. |
| `PositionsCard.tsx` | 299 | What is on right now — split into working orders and open positions, because reading them as one list was the source of several misunderstandings. |
| `ExitBars.tsx` | 200 | The two exits, each behind a tick box, both starting off. The line underneath — the actual exit price — is the point of the control. |
| `OrdersPanel.tsx` | 185 | Every order, looking backwards. Date filter defaulting to today, four server-defined statuses, Excel download. |
| `CloseAllButton.tsx` | 182 | Square off everything. Reports per trade rather than pass/fail, because a partial result is the common one. |
| `AccountCard.tsx` | 173 | The money, in plain words: what went in, what is free, what is at risk, what is booked. |
| `EditExitsSheet.tsx` | 163 | Change the stop and target on a live position. Reads the levels **from the book**, not the plan. |
| `ModeSwitch.tsx` | 135 | Which book the desk is trading on. The server decides; this asks and shows the answer. |
| `ModeBanner.tsx` | 32 | The standing reminder of which mode is live. |

### Desk UI (`components/desk/`, `chain/`, `research/`)

| File | Lines | What it is for |
|---|---:|---|
| `chain/ChainTable.tsx` | 324 | The board. Tappable prices (one tap opens the ticket), bid shown by default because it is what a seller receives, uncrossable bids struck through. |
| `desk/RecommendPanel.tsx` | 253 | What to sell, in as few words as possible. |
| `research/BacktestPanel.tsx` | 226 | Run the backtest from the screen. |
| `desk/MoveSection.tsx` | 169 | What BTC has actually done, under what the market says it will do. |
| `desk/LoginPage.tsx` | 98 | The gate. Says as little as possible when it fails. |
| `research/Explain.tsx` | 90 | A labelled number that can show its own arithmetic. |
| `desk/LivePrice.tsx` | 74 | Spot, ticking, and how far it has come since the contract opened. |
| `desk/BiasSection.tsx` | 62 | Which way the option board is leaning. |
| `research/DateTimePicker.tsx` | 118 | A date and time always read as India time, because the strategy is defined in IST. |

### Shared UI (`components/ui/`) — 14 files, ~640 lines

shadcn-style primitives on Radix, adapted for one hard constraint: **Tailwind's
preflight is off in this project**, so each of these keeps the platform look
where that helps and resets it explicitly where it does not.

`select.tsx` (95, a listbox rather than a native `<select>`), `sheet.tsx` (83,
bottom on a phone, centred on a desktop), `collapsible-card.tsx` (76, folded
state remembered per card), `card.tsx` (68), `checkbox.tsx` (49),
`slider.tsx` (48, 4px track and a 40px hit area), `date-range-picker.tsx` (144,
presets plus a calendar, dates as `YYYY-MM-DD` strings throughout),
`calendar.tsx` (42), `toggle-group.tsx` (40, scrolls rather than squeezes),
`button.tsx` (40), `stat.tsx` (41), `badge.tsx` (31), `input.tsx` (27, number
spinners removed — they are one pixel from the field on a trading screen),
`popover.tsx` (26), `separator.tsx` (21), `section.tsx` (20), `label.tsx` (15).

### App shell, hooks, lib, api

| File | Lines | What it is for |
|---|---:|---|
| `App.tsx` | 740 | The whole desk: layout, polling cadence, and which panels exist. |
| `styles.css` | 672 | The Binance-style palette and every base reset preflight would have done. |
| `types/desk.ts` | 322 | The shapes the desk API returns. |
| `layout/ErrorLogPanel.tsx` | 244 | The error log for whoever has to fix it — a readable list with stacks, not a toast. |
| `types/trade.ts` | 198 | The shapes the trading API returns. |
| `lib/format.ts` | 127 | How numbers are written on this desk, in one module: rupees main, dollars small. |
| `api/client.ts` | 105 | One place that knows how to talk to the API — and what counts as an error worth logging. |
| `api/trade.ts` | 90 | The trading calls. |
| `lib/report-error.ts` | 83 | Sends a browser failure to the server. Never throws, never reports its own failure, folds repeats locally. |
| `hooks/usePoll.ts` | 58 | Call something on a timer and keep the last good answer. A screen that goes empty for a second is worse than one that says it is stale. |
| `lib/csv.ts` | 52 | A CSV that opens cleanly in Excel: RFC quoting, BOM, CRLF. |
| `layout/ErrorBoundary.tsx` | 51 | A component that throws takes its part of the screen down, not the desk. |
| `hooks/usePersisted.ts` | 41 | State that survives a reload; every access wrapped, because a private window throws. |
| `api/desk.ts` (40), `types/errors.ts` (28), `api/session.ts` (21), `api/errors.ts` (17), `main.tsx` (17), `api/backtest.ts` (11), `lib/utils.ts` (7) | | Small and self-evident. |

---

## `app/server/test` — 12 files, 3,045 lines, 265 tests

| File | Lines | What it covers |
|---|---:|---|
| `trading/orders.test.ts` | 1,269 | The 80-case matrix: entry, partial fill, timeout, reject, network failure, duplicate prevention, TP/SL, races, disconnects, restart recovery, reduce-only protection. Cases 75–80b are the take-profit story. |
| `engine.test.ts` | 292 | Engine internals — chase, client ids, serialisation. |
| `trading/margin.test.ts` | 188 | Margin against the real Delta ticket. |
| `trading/machine.test.ts` | 185 | The reducer, case by case. |
| `errors.test.ts` | 183 | The error log, redaction, and `worthLogging`. |
| `probability.test.ts` | 170 | The three probability questions. |
| `trading/payload.test.ts` | 133 | Pins the exact JSON body sent to Delta. Three `bad_schema` refusals came from this body; it is now asserted field by field. |
| `trading/harness.ts` | 122 | The rig every trading test is built on. |
| `trading/entry-types.test.ts` | 122 | Limit, market, chase, fallback. |
| `migrate.test.ts` | 117 | Runs once, rolls back on failure, survives a reopen. |
| `trading/status.test.ts` | 109 | Order status and IST day boundaries. |
| `trading/store.test.ts` | 88 | Written after the `plan`-column bug: the first test is a plan changed and read back. |
| `trading/money.test.ts` | 67 | Tick rounding, in the direction that never costs you. |

## `app/web/src` tests — 11 files, 182 tests

`OrderTicket.test.tsx` (432), `PositionsCard.test.tsx` (347),
`EditExitsSheet.test.tsx` (163), `format.test.ts` (150),
`ChainTable.test.tsx` (139), `client.test.ts` (131),
`ExitBars.test.tsx` (118), `usePoll.test.ts` (114),
`AccountCard.test.tsx` (93), `date-range-picker.test.tsx` (91),
`csv.test.ts` (69).

---

## `harvester` — 2 files, 289 lines

| File | Lines | What it is for |
|---|---:|---|
| `harvest_chain.py` | 171 | Captures the BTC daily-option chain at 05:30 IST plus the 12:00 UTC settlement — the two moments the strategy is defined at. |
| `store.py` | 118 | SQLite store for those snapshots. |

Run by `deploy/refresh.sh`, which harvests, then hands the desk a consistent
copy via a SQLite backup rather than a file grab — so it never ships a
half-written WAL.

## `research` — 17 files, 2,638 lines

The studies the strategy rests on. Not deployed; kept because every number in
`domain/` traces back to one of them.

| File | Lines | The question it answers |
|---|---:|---|
| `analyze.py` | 391 | Which strike-selection, exit and filter variants actually did better. |
| `final_report.py` | 248 | Premium floors, the four variants, weekday effects, hedging. |
| `study_premium.py` | 234 | Does a minimum premium of $N ever give a 100% win rate? |
| `feature_screen.py` | 185 | Which indicators actually help, and which only look like they do. |
| `reference_test.py` | 179 | Tests the claims in `reference.md` against the harvested data. |
| `calibrate.py` | 167 | How often an option really expires worthless, against what the model says. |
| `harvest_paths.py` | 142 | Intraday mark paths for the legs the strategy sells. |
| `study_horizons.py` | 140 | How BTC actually moves over 5m to 12h. |
| `backtest.py` | 140 | Short-straddle backtest on Delta India dailies. |
| `algo_report.py` | 121 | An AlgoTest-style report for comparison. |
| `features.py` | 115 | Daily BTCUSD technical features. |
| `final_stack.py` | 112 | The final stacked strategy. |
| `recon_and_sweep.py` | 109 | Reconciliation pack, variants, PE band sweep. |
| `harvest_oi.py` | 107 | Open interest on the legs sold, so OI could be tested rather than assumed. |
| `measure_horizons.py` | 91 | Writes the horizon table the desk reads at runtime. |
| `harvest.py` | 89 | Raw chain capture, one JSON per day. |
| `section_k_per_leg.py` | 68 | Per-leg breakdown for section K. |

---

## Deployment and docs

`deploy/deploy.sh` builds both images, refuses to build if a credential is
reachable from the build context, and rolls back to the previous images if the
new ones fail their health check. `deploy/refresh.sh` runs the harvester.
`deploy/docker-compose.yml`, `nginx.conf`, `nginx.docker.conf` and
`btc-desk-api.service` are the rest of it.

`docs/` holds `ARCHITECTURE.md` (how it fits together), `DB-INVENTORY.md` (every
table and column), `TODO.md` (the running record of what broke and why —
the most useful file here after the code), `DEPLOY.md`, `reference.md`,
`PREDICTION-ENGINE-SPEC.md`, `test.md` and `next.md`.
