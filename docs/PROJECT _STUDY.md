# Project Study — BTC Daily Options Desk

> One-person BTC daily-options desk on **Delta Exchange India**. Sells out-of-the-money premium on the daily contract, sizes the position from two years of settled chains, and places and manages orders live.

---

## Architecture at a Glance

```
Delta Exchange India
 ┌──────────┴───────────┐
 │ public               │ signed (the user's own account)
 ▼                      ▼
market/delta.ts      delta/signed.ts
market/chain.ts      trading/exchange/delta.ts  ◄── ONLY file that moves money
market/moves.ts               │
     │                        │  ExchangePort  (~10 methods, the whole surface)
     │                        │       ▲
     │               trading/exchange/paper.ts  (simulator)
     ▼                        ▼
  domain/         ◄──   trading/engine.ts  ──►  trading/store.ts  ──►  PostgreSQL
  (pure maths)         (no clock, no timers)
                                │
                        trading/service.ts   ── paper/live switch, server-authoritative
                                │
                         http/ routes  ──►  observability/errors.ts  ──►  PostgreSQL: errors
                                │
                         app/web  (React 18 + Vite + Tailwind + Radix)
                                │
                         failures ──►  POST /api/errors
```

**Four Docker processes in production:**
| Process | Image | Role |
|---|---|---|
| `btc-desk-api` | Fastify (Node) | The entire trading backend |
| `btc-desk-web` | nginx | Serves the Vite bundle, proxies `/api` |
| `btc-desk-analytics` | Python | Display-only models (read-only) |
| `db` | PostgreSQL 17-alpine | The single database |

---

## Backend (`app/server/src/`)

### Key directories

| Dir | Purpose |
|---|---|
| `trading/` | The engine — entry, protection, exit lifecycle. `engine.ts` is the core reducer (88 KB). |
| `domain/` | Pure maths: score, EV, probability, calibration, forecast, BS, patterns, indicators, market-state. No I/O. |
| `http/` | Fastify routes. 8 route files: `trade`, `desk`, `strategy`, `stream`, `backtest`, `report`, `errors`, `session`. |
| `market/` | Live market data from Delta's public API: chain, quotes, moves. |
| `delta/` | Signed calls to Delta (the one place that can move money). |
| `db/` | DB pool (`pg.Pool`), migrations, settings cache, analytics schema. |
| `strategy/` | Saved strategies, their scheduler, and run journal. |
| `auth/` | Session cookie auth, recovery codes, rate-limits, audit log. |
| `notify/` | Telegram alerts on fills. Pure message builders + async sender. |
| `observability/` | Error log (`errors` table). Never blocks a route. |
| `backtest/` | Back-tests against `chain.db`. |

### The trading engine rules (from painful experience)

1. **Anything labelled as what the exchange is doing must be read from the exchange** — not from local belief.
2. **A simulator is evidence about logic, never about the venue's semantics** — the take-profit-market order fired immediately because the simulator was built from the same wrong assumption.
3. **Position is counted from fills, never assumed** — `position = exit.size - entry.size`. Closed = 0, not -0.
4. **The engine owns no clock** — time arrives as `now()`, work as `poll()`. Enables 81 deterministic cases.
5. **The log is only worth reading if everything in it needs fixing** — `http/refuse.ts` marks deliberate 4xx so they are not logged.
6. **A target is a price, a stop is an exit** — target = resting reduce-only limit buy; stop = `stop_limit` trigger at the mark.
7. **A feed's age is the newest of all sources** — stale socket replaced by REST poll still shows correct freshness.

### Order types used

| Role | Type | Why |
|---|---|---|
| Entry | `limit` | Price floor; never market (got swept on 10 Sep) |
| Take-profit | `limit` (reduce-only buy) | Fills at price or better, never worse. Market target fired instantly. |
| Stop-loss | `stop_limit` | `stop_market` rejected by Delta with no order book. `stop_limit` at 15% slack. |
| Close / manual | `limit` | Same floor protection |

### Concurrency

Per-trade promise-chain mutex in `engine.ts`:
```ts
private withTrade<T>(tradeId: string, fn: () => Promise<T>): Promise<T> {
  const previous = this.queue.get(tradeId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  this.queue.set(tradeId, next.then(() => {}, () => {}));
  return next;
}
```
Public methods enqueue; `*Inner` methods assume they are already inside one.

---

## Database (`btc_desk` PostgreSQL)

### Tables by area

| Area | Tables |
|---|---|
| **trading** | `trades`, `trade_events`, `settings`, `mtm_samples` |
| **strategy** | `strategies`, `strategy_runs` |
| **auth** | `auth_user`, `auth_sessions`, `auth_recovery_codes`, `auth_limits`, `auth_events` |
| **errors** | `errors` |
| **market** | `oi_snapshots`, `chain_features`, `option_snapshots`, `option_snapshots_1m`, `trade_flow_1m`, `option_flow_1m`, `perp_snapshots`, `market_states` |
| **analytics** | `outlook_states`, `chain_states`, `analytics_publish_meta` |
| **ledger** | `schema_migrations` |

Plus `chain.db` (SQLite, read-only at runtime): 735 days of settled option chains.

### Migration system

- Ordered list in `db/migrate.ts`, each with a permanent id (convention: `<schema>-NNN-what-it-does`)
- Each runs inside a transaction; a failure rolls back and **stops the boot** (trading engine must never start against a half-migrated DB)
- Advisory lock (`pg_advisory_lock`) prevents two boots racing
- `/api/health` lists every applied migration

### Key data patterns

- `BIGINT` timestamps returned as numbers (pool wraps this)
- Event sourcing: `trade_events` is an append-only log; `hydrate()` replays through `recompute()`
- `ErrorLog.record()` is fire-and-forget (queues write) — a logger that awaits the network slows the route
- Settings cache in `db/settings.ts` — wraps a PostgreSQL KV table

---

## Frontend (`app/web/src/`)

### Stack

React 18 · Vite · **Tailwind CSS** · Radix UI · `lightweight-charts` (candles)

### Key files

| File/Dir | Purpose |
|---|---|
| `App.tsx` (39 KB) | Root component — routing, layout, all top-level state |
| `styles.css` (194 KB) | Global CSS + Tailwind; Radix theme overrides |
| `api/client.ts` | HTTP client (fetch wrapper) |
| `api/trade.ts`, `api/desk.ts`, etc. | Typed API call wrappers |
| `types/trade.ts` | Mirrors `server/src/trading/types.ts` — kept flat |
| `lib/exit-input.ts` | `ExitInput` type + helpers for the exits UI |
| `lib/format.ts` | **The only place numbers are formatted.** Rupees primary, dollars secondary. |
| `lib/overview.ts` | The heavy desk overview computation (74 KB) |
| `hooks/` | React hooks for streaming data, polling, etc. |

### Component areas

| Dir | Components |
|---|---|
| `components/trade/` | `OrderTicket`, `PositionsCard`, `ExitBars`, `EditExitsSheet`, `AddLotsSheet`, `ClosePositionSheet`, `OrdersPanel`, `AccountCard`, `AlertSwitch` |
| `components/chain/` | The strike chain table |
| `components/desk/` | The main desk view |
| `components/overview/` | The overview/summary panel |
| `components/strategy/` | Strategy builder UI |
| `components/research/` | Research / backtest views |
| `components/report/` | Order history / report |
| `components/auth/` | Sign-in form |
| `components/ui/` | Design system primitives |

### The exit input model (`ExitInput`)

```ts
export type ExitInput = {
  on: boolean;
  mode: 'pct' | 'points' | 'price';
  pct: number;      // 0.8 = 80%
  points: number;   // absolute distance from entry
  price: number;    // the level itself
};
```

Each mode keeps its own number, so switching back finds where you left it.

### Money arithmetic

```
money = quoted_price × contracts × contractValue   (contractValue = 0.001 BTC)
```
Display: **₹ main, $ small**, at ₹85. Only `lib/format.ts` decides how a number is written.

---

## API Routes

| Route file | Key endpoints |
|---|---|
| `trade.routes.ts` | `POST /api/trade/preview`, `POST /api/trade/place`, `POST /api/trade/close`, `GET /api/trade/status` |
| `desk.routes.ts` | Live desk state, chain data, quotes, health |
| `strategy.routes.ts` | CRUD + run/stop for saved strategies |
| `stream.routes.ts` | SSE stream for live updates |
| `session.routes.ts` | Sign in / sign out / session check |
| `report.routes.ts` | Order history |
| `backtest.routes.ts` | Back-test against chain.db |
| `errors.routes.ts` | Error log read + browser error ingestion |

All routes talk JSON. Auth is one session cookie. Server is the authority on live/paper mode.

---

## Testing

- **Server**: 1,153 tests with `node:test` via `tsx`. 81-case matrix in `trading/engine.ts` covering entry, fills, protection, TP/SL, races, restarts.
- **Web**: 946 tests with `vitest` + `@testing-library/react`.
- Test DB: throwaway PostgreSQL on 127.0.0.1:5433, `btc_test_<random>` schema, dropped on process exit.
- Engine matrix runs on `MemoryTradeStore` — no DB needed, stays fast and deterministic.

---

## Deploy

```
./deploy/deploy.sh        # build images, health-check, roll back on failure
./deploy/refresh.sh       # run harvester → new chain.db via SQLite backup
./deploy/backup-db.sh     # pg_dump, 14-day retention
```

`--check` validates without changing. `--host user@ip` ships locally-built images.

---

## The Type Error Fixed Today

**File**: [`ExitBars.test.tsx`](file:///home/agent/test-delta/app/web/src/components/trade/ExitBars.test.tsx) lines 244–245

The "a stop the desk refused to place" test built `ExitInput` objects with `value: 0` — a field that no longer exists. When `ExitInput` gained the three-mode design (`pct` / `points` / `price`) the `value` shorthand was removed. The fix replaces both occurrences with the full `{ pct: 0, points: 0, price: 0 }` shape the type now requires.
