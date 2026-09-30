# Architecture

A one-person BTC daily-options desk on Delta Exchange India. It sells
out-of-the-money premium on the daily contract, from the order ticket or on a
schedule, and places and manages the orders live: entry, target, stop, exit.
Around that it records the market -- the option board, the perpetual's tape and
book -- and draws it on one price chart.

This page is the map. The rules the desk runs on, and the incidents behind
them, are in [decisions/](decisions/README.md). What exists -- every file,
route, table and environment variable -- is generated in
[reference/](README.md#reference).

---

## Processes

```
                       delta.thannigo.in :443
                                │  edge nginx (TLS, another stack on the host)
                                ▼
   ┌──────────── compose project btc-desk (deploy/docker-compose.yml) ────────────┐
   │  web   nginx: the built React bundle, and /api -> api:8787 (SSE unbuffered)   │
   │  api   Fastify on Node 24: the whole backend, the trading engine included    │
   │  db    PostgreSQL 17: everything the desk writes                             │
   │  adminer   (profile admin)  database console, read-only by default          │
   │  harvester (profile ops)    builds chain.db, run by deploy/refresh.sh        │
   └──────────────────────────────────────────────────────────────────────────────┘
        volumes: pgdata (the database) · data (/srv/data/chain.db)
```

`web` is published on the docker bridge only (`172.17.0.1:8099`), so nothing
reaches the app except through the TLS edge. `api` and `db` have no host port.
The API container runs as a non-root user on a read-only root filesystem with
every capability dropped. The analytics service was retired on 29 Sep 2026.

## The shape of the backend

```
       Delta Exchange India
     ┌──────────┴───────────┐
     │ public               │ signed (the account)
     ▼                      ▼
 market/delta.ts        delta/signed.ts
 market/chain.ts        trading/exchange/delta.ts   ◄── the only file that moves money
 market/*-socket.ts              │
     │                           │  ExchangePort  ◄── the whole surface, ~10 methods
     │                           │       ▲
     │                    trading/exchange/paper.ts  (the simulator)
     ▼                           ▼
  domain/            ◄──   trading/engine.ts  ──►  trading/store.ts ──► trades, trade_events
  pure maths:              (no clock, no timers)
  bs, probability,                │
  calibration, score,             ▼
  forecast, ev …         trading/service.ts  ── paper/live, timers, alerts
                                  │           ◄── strategy/runner.ts (the scheduler)
                                  ▼
                        http/routes/*  ── http/app.ts: session gate, CSRF, error hooks
                                  │
                                  ▼  JSON over one session cookie, SSE for live prices
                        app/web  (React 18 · Vite · Tailwind · Radix · lightweight-charts)

  chain.db (SQLite, read-only) ──► backtest/, domain/forecast.ts, domain/calibration.ts
```

| Area | Directory | What it owns |
|---|---|---|
| Trading | [`trading/`](../app/server/src/trading/) | The engine, the gates (`precheck.ts`), the journal, margin, charges, money rounding. The part that can lose money. |
| Strategies | [`strategy/`](../app/server/src/strategy/) | Saved strategies, the scheduler, strike selection, stepped exits, the trend plan's paper log. See [features/strategies.md](features/strategies.md). |
| Domain | [`domain/`](../app/server/src/domain/) | Pure maths, no I/O: Black-Scholes, probability, calibration against `chain.db`, scoring, indicators, patterns. |
| Market data | [`market/`](../app/server/src/market/) | Delta's public REST and sockets, the chain, and the recorders that write the market tables. |
| HTTP | [`http/`](../app/server/src/http/) | The app, the session gate, eight route files. See [reference/api.md](reference/api.md). |
| Sign-in | [`auth/`](../app/server/src/auth/) | One user, password + TOTP, hashed sessions, recovery codes, rate limits, the security log. |
| Alerts | [`notify/`](../app/server/src/notify/) | Telegram: pure message builders and a sender that never throws into the engine. |
| Database | [`db/`](../app/server/src/db/) | The pool, the migration ledger, the settings cache. |
| Errors | [`observability/`](../app/server/src/observability/) | One error table for server, browser, exchange and trading failures. |
| Research | [`backtest/`](../app/server/src/backtest/) | Backtests over `chain.db` and the candle studies that generate `*.data.ts` scorecards. |

## What runs in the background

Started by [index.ts](../app/server/src/index.ts) once the schemas are
migrated -- a migration that fails stops the boot, because a desk that cannot
reach its journal must not take an order.

| Every | What | Writes |
|---|---|---|
| socket + 8 s REST | The option board (every BTC contract's ticker) | memory; the REST poll is the cold start and fallback |
| 1 s (engine poll) | Each open trade: fills, protection, stop watch, exit time | `trades`, `trade_events` |
| 20 s | The strategy scheduler: is an entry or exit due | `strategy_runs`, then orders |
| 1 min | Option snapshots (1-minute and 5-minute grains), the perp, BTC itself | `option_snapshots*`, `perp_snapshots`, `index_1m` |
| 5 min | The board's own record: straddle, skew, walls, max pain | `chain_features`, `oi_snapshots` |
| 20 s | The perp's tape from the `all_trades` socket, summed per minute | `trade_flow_1m`, `option_flow_1m`, `large_prints` |
| 10 s sample, 20 s write | The perp's order book, binned at $10 | `book_heat_1m` |
| 5 min | The trend plan's paper log on closed 1H / 4H candles | `trend_paper` |
| 1 min | The day's mark-to-market P&L | `mtm_samples` |

A recorder that fails writes one warning to the error log; it never stops the
desk.

## The screen

[`app/web/src/App.tsx`](../app/web/src/App.tsx) holds seven tabs: **desk** (the
price chart and the option chain), **trade** (order ticket, positions, account),
**orders**, **strategy**, **pnl**, **settings** and **errors**. Prices stream over
`/api/stream` (server-sent events); everything else is polled with `usePoll`,
which keeps the last good answer and stops while the tab is hidden.
[`lib/format.ts`](../app/web/src/lib/format.ts) is the only place a number is
written: rupees main, dollars small, at ₹85. The chart is documented in
[features/price-chart.md](features/price-chart.md).

---

## The lifecycle of one trade

1. **Tap a price on the chain**, or a strategy's entry comes due. The ticket
   gets the strike, the side and that strike's own book.
2. **`POST /api/trade/preview`**: every gate runs, nothing is sent. Refusals
   appear above the button, not after the click.
3. **`POST /api/trade/place`**: [precheck.ts](../app/server/src/trading/precheck.ts)
   runs again server-side -- a browser is never trusted with a gate. Spread and
   depth gates apply only when the order crosses the spread.
4. **Entry.** A limit at the offer or the bid. With `chase`, the engine walks it
   toward the bid by editing in place, so it never leaves the book; a timeout
   cancels only when a market fallback was asked for.
5. **Protection.** Once the exchange agrees a position exists, `protect()`
   reconciles the target and the stop against the book ([0001](decisions/0001-read-the-exchange.md)).
6. **Exit**, whichever comes first: the resting target fills; the desk sees the
   offer through the stop and closes; the backstop at Delta triggers; the
   strategy's exit time arrives; or the person closes. The other exit is
   cancelled before it can reopen the position ([0006](decisions/0006-target-is-a-price-stop-is-an-exit.md)).
7. **Journal.** Every step is an appended event, replayed on restart
   ([0009](decisions/0009-append-only-journal.md)).

## Money

Options are quoted in **USD per BTC**; one contract is **0.001 BTC**:

```
money = quoted × contracts × 0.001        -- premiumUsd(), never inline
```

A quote of 19 on ten contracts is **$0.19**, not $19; getting that wrong by
1000x reached the screen once. Margin is calibrated against a real Delta ticket
(index 78,405.5, 10 lots, 200x, funds required 3.93), not the documentation:

```
initialMargin = spot / leverage × contractValue      (premium is NOT included)
fee           = min(0.01% × notional, 3.5% × premium) + 18% GST
liquidation   = premium + spot × 0.5 / leverage
```

Charges were checked against the account's own trade export: all 72 fills
match "Fees paid" to the last digit. Prices are rounded to whole ticks, a
seller up and a buyer down, so rounding never moves against the desk.

## Alerts

A Telegram message when an entry fills, when an exit fills, when a position is
found closed on Delta without an exit fill, when a fill slips 5% or more past
its trigger, on security events, and one summary when the day's last position
closes. Off unless `TG_TOKEN` and `TG_CHAT_ID` are both set. Only what printed
is announced; a replay after restart announces nothing; Telegram being down
costs an alert, never an order.

## Security

- **Sign-in**: password, then a TOTP code; ten single-use recovery codes. The
  TOTP secret is sealed (AES-256-GCM) under `DESK_SESSION_SECRET`. Sessions
  are rows holding only a SHA-256 of the token, last a week, and can be ended
  from the profile screen. Missing configuration fails closed.
- **The gate** decides on the route Fastify matched, never on the URL text
  (`/%61pi/...` once walked past it). A route is closed unless it says
  otherwise; see the Session column in [reference/api.md](reference/api.md).
- **CSRF**: every POST, PUT, PATCH and DELETE needs an `Origin` or `Referer`
  naming this host, beyond `SameSite=Strict`. No CORS.
- **Proxies**: `trustProxy` is a fixed list of private ranges, so the sign-in
  limiter cannot be walked past with a forged `X-Forwarded-For`.
- **Headers**: CSP, frame denial, `nosniff`, referrer policy on every nginx
  location.
- The 11 Sep audit and what is still open:
  [history/2026-09-11-security-audit.md](history/2026-09-11-security-audit.md),
  [TODO.md](TODO.md).

## Testing

About 1,200 server tests (`node:test` via tsx, each file in its own throwaway
database) and 950 browser tests (vitest + Testing Library). The engine's order
matrix runs on the paper exchange and an in-memory store, deterministically;
nearly every case is named after the incident that produced it.
`payload.test.ts` pins the exact JSON sent to Delta, field by field. What the
suite **cannot** tell you is anything about Delta's own semantics
([0002](decisions/0002-simulator-is-not-the-venue.md)). How to run it:
[guides/local-development.md](guides/local-development.md).
