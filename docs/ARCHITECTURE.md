# Architecture

A one-person BTC daily-options desk on Delta Exchange India. It sells
out-of-the-money premium on the daily contract, sizes the position from two
years of settled chains, and places and manages the orders live.

This document is the map. `FILE-INVENTORY.md` is the index of files,
`DB-INVENTORY.md` the index of tables, and `TODO.md` the running record of what
broke and why — which is worth reading before changing anything in `trading/`.

---

## The shape of it

```
       Delta Exchange India
     ┌──────────┴───────────┐
     │ public               │ signed (the user's own account)
     ▼                      ▼
 market/delta.ts        delta/signed.ts
 market/chain.ts        trading/exchange/delta.ts  ◄── the only file that moves money
 market/moves.ts                 │
     │                           │  ExchangePort  ◄── the whole surface, ~10 methods
     │                           │       ▲
     │                    trading/exchange/paper.ts  (the simulator)
     ▼                           ▼
  domain/            ◄──   trading/engine.ts   ──►  trading/store.ts  ──►  trades.db
  score, recommend,        (no clock, no timers)
  probability,                    │
  calibration,                    ▼
  forecast, bs         trading/service.ts   ── paper/live switch, server-authoritative
     │                            │
     └──────────┬─────────────────┘
                ▼
          http/ routes  ── app.ts hooks ──► observability/errors.ts ──► errors.db
                │
                ▼   JSON over one session cookie
          app/web  (React 18 + Vite + Tailwind + Radix)
                        │
                        └── failures ──► POST /api/errors ──► the same errors.db

  chain.db ──► domain/, backtest/    (735 settled days; read-only at runtime)
```

Two processes in production: `btc-desk-api` (Fastify) and `btc-desk-web`
(nginx serving the built bundle and proxying `/api`). One volume, `/srv/data`,
holding the three databases.

---

## The five rules

Everything below was learned by getting it wrong first. They are in `TODO.md` at
length; this is the short form.

### 1. Anything labelled as what the exchange is doing must be read from the exchange

Broken three times, and each time it hid a deeper bug.

- The exits panel said "on the book now" and read the plan. They agree until
  they do not — and the case where they differ is the only one worth showing.
- `protect()` decided what to place from memory rather than from the book, and
  put a second reduce-only order beside the one it meant to replace.
- The plan itself was stale, because `store.save` never wrote the `plan` column.

`protect()` is now a reconciler: read the book, classify each leg as
right / wrong-price / unwanted / missing, prefer an in-place edit (`PUT`), and
fall back to a **verified** cancel before any replacement is sent. An unverified
cancel is exactly how two live orders happen.

### 2. A simulator is evidence about our logic, never about the venue's

This one cost real money on 9 September 2026.

A resting limit target only fills when somebody *offers* at it, so a decayed
option's mark can fall straight through the level untouched — which is what a
short at 2.70 with a target at 1.10 did while marked at 1.00. The target was
changed to a `take_profit_order` trigger so Delta would fire it on the mark.
Delta fires a *buy* trigger in the opposite direction to the reading of the
docs, and it fired the instant it landed: a short sold at 7.00 with a target at
0.50 bought itself back at 7.00 within four seconds. Twice.

**Five tests asserted the target fired correctly, and all five passed** — because
`PaperExchange` had been written to the same reading of the docs as the engine.
A simulator built from the code's assumption cannot test that assumption; it
only proves the code agrees with itself.

So: the target rests as a plain reduce-only limit buy, which has the one
property that cannot be got wrong — **it fills at its price or better, never
worse** — and the level is judged in `takeProfitIfReached`, in arithmetic this
repo owns and pins. The stop stays a trigger at Delta *as well*, because it is
the only protection that survives this process dying, and it is watched from
here too. Case 80 is the reproduction; case 80b is the venue-independent
property: an exit may never print worse than the level that asked for it.

### 3. Position is counted from fills, never assumed

`trading/machine.ts` is a pure reducer over fills with no I/O, so every case in
the matrix can be built by hand. `position = exit.size - entry.size` — written
that way round so a closed trade is `0` and never `-0`, which is a real
distinction to `Object.is` and was a real bug.

Reduce-only is enforced at *fill* time, not just at submission: a take-profit
and a stop both printing would otherwise turn a short into a long.

### 4. The engine owns no clock

Time arrives as `now()`, work arrives as `poll()`. Nothing in `engine.ts` starts
a timer. That is why 81 cases including races, disconnects and restart recovery
can run in under a second, deterministically.

Concurrency is handled by one per-trade promise-chain mutex:

```ts
private withTrade<T>(tradeId: string, fn: () => Promise<T>): Promise<T> {
  const previous = this.queue.get(tradeId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  this.queue.set(tradeId, next.then(() => {}, () => {}));
  return next;
}
```

Public methods take the queue; `*Inner` methods assume they are already inside
one. Mixing those up is how the poll loop raced a screen action into six
duplicate take-profits.

### 5. The log is only worth reading if everything in it needs fixing

This desk says no for a living — the spread gate, the premium floor, the mode
switch refusing to flip with a position open. Every one of those was writing an
error row. `http/refuse.ts` lets a route mark a 4xx it *meant*, and
`worthLogging(status, deliberate)` is the whole rule in one testable function.
Unmarked responses are still logged, so forgetting to mark one makes the log
noisier rather than blinder. See `DB-INVENTORY.md` for the table.

---

## The lifecycle of one trade

1. **Tap a price on the chain.** `ChainTable` hands the ticket the strike, the
   side, and that strike's own book. One tap, no retyping.
2. **`POST /api/trade/preview`.** Every gate runs, no order is sent. This is
   what the button is allowed to be sure of, and refusals appear *above* the
   button rather than after the click.
3. **`POST /api/trade/place`.** `precheck.ts` runs again server-side — a browser
   is never trusted with a gate. Spread and depth gates apply **only when
   crossing**; a resting order is not blocked by a wide book, which was a real
   complaint on a 17/19 board.
4. **Entry.** A limit at the bid or the offer. If `chase` is on, `pollInner`
   walks it toward the bid in steps, **editing in place** so the order never
   leaves the book. A timeout only cancels when `marketFallback` is set —
   cancelling a resting entry on a 5-second timer guaranteed it never filled,
   which is exactly what happened once.
5. **Protection.** Once the *exchange* agrees a position exists (not once we
   think it does — sending reduce-only before Delta registers the fill produced
   seventy `no_position_for_reduce_only` refusals in a loop), `protect()`
   reconciles the target and stop against the book.
6. **Exit.** Whichever comes first: the resting target fills; the exchange stop
   triggers; `takeProfitIfReached` sees the mark reach a level and closes at
   market; or the person hits close. Whichever wins, the other leg is cancelled
   before it can re-open the position.
7. **Journal.** Every step is an appended event. `hydrate()` replays them through
   `recompute()`, so a fix to the arithmetic repairs closed trades too.

---

## Money, and the mistake worth knowing

Options are quoted in **USD per BTC**; one contract is **0.001 BTC**. So:

```
money = quoted × contracts × 0.001
```

A quote of 19 on ten contracts is **$0.19**, not $19. Getting this wrong by
1000× reached the screen once. It lives in one function, `premiumUsd()`, and
nothing computes it inline.

Margin is calibrated against a real Delta ticket — index 78,405.5, 10 lots,
200x, funds required 3.93 — not against the documentation:

```
initialMargin = spot / leverage × contractValue      (premium is NOT included)
fee           = min(0.01% × notional, 3.5% × premium)
liquidation   = premium + spot × 0.5 / leverage
```

Display: **rupees main, dollars small**, at ₹85. `lib/format.ts` is the only
place that decides how a number is written.

---

## Paper and live

`service.ts` decides once, from the environment: live requires
`DELTA_LIVE_TRADING` on **and** credentials present. The switch is
server-authoritative — the browser asks and the server decides — and it refuses
to flip while a position is open. A page that could put itself into live mode by
setting a flag in its own state is a page that can do it by accident.

The engine never reads a display cache.

---

## Alerts

A Telegram message when an entry fills, when an exit fills, when a position is
found closed on Delta without an exit fill, and one summary for the day when the
last position closes. Off unless `TG_TOKEN` and `TG_CHAT_ID` are both set.

```
engine.commit ──save──► trades.db
      │
      └─► onEvent(event, before, after, plan)   ◄── after the save, inside a try
                │
       service.ts ── notify/messages.ts  (pure: event → message, or nothing)
                │
          notify/telegram.ts  ── held 4 s per trade and leg ──► Telegram
```

Three rules, same spirit as the five above:

- **An alert can never touch a trade.** `onEvent` runs after the journal is
  written, a throwing listener is caught and logged, and `notify` returns before
  anything reaches the network. Telegram being down costs an alert, not an order.
- **Replay is silent.** Only `commit` calls the listener. `hydrate()` rebuilds
  state without it, so a restart does not announce yesterday's fills again.
- **Only what printed.** Submitted orders, protection placed and refusals send
  nothing. A channel that buzzes for those is muted, and then the stop-loss
  alert goes unread.

The day summary's charges use `feePerContract` — the ticket's own model — on
both sides of every trade, and say *est.*: the model has no GST, and Delta's
statement is the authority. See `TODO.md`.

---

## Testing

279 server tests (`node:test` via tsx), 238 browser tests (vitest +
@testing-library). Run `npm test` in `app/server` and `npx vitest run` in
`app/web`; `npm run typecheck` in both.

The server suite is an 81-case matrix covering normal entry, partial fill,
timeout, reject, network timeout, duplicate prevention, TP/SL, race conditions,
disconnects, restart recovery and reduce-only protection. Nearly every case
names the incident that produced it. `payload.test.ts` pins the exact JSON body
sent to Delta field by field, because three `bad_schema` refusals came out of
that body — a client order id 38 characters long with a colon in it,
`reduce_only` sent as the string `"true"`, and `product_symbol` sent alongside
`product_id`.

What the suite **cannot** tell you is anything about Delta's own semantics. See
rule 2.

---

## Deploying

`./deploy/deploy.sh` builds both images, refuses to build if a credential is
reachable from the build context, health-checks, and rolls back to the previous
images if the new ones fail. `--check` validates without changing anything;
`--host user@ip` builds locally and ships.

`./deploy/refresh.sh` runs the harvester and hands the desk a consistent
`chain.db` via a SQLite backup rather than a file grab.

`GET /api/health` returns the day count, the date range, and the applied trade
migrations — so a deploy that did not migrate is visible without a shell.

---

## Open items

In `TODO.md`, and the ones that matter most:

- **Delta's stop direction is still unverified.** It has never been observed
  misfiring and a buy stop above the market is the conventional case — but the
  take-profit was conventional too. It wants one deliberate live test with one
  lot.
- `post_only` for a guaranteed resting entry; `time_in_force: ioc`.
- Trailing stops (`trail_amount`).
- Reconciling against `/v2/orders/history` as well as the open book.
- The two premium floors are still different numbers: 5 in the trading gate, 15
  as the chain default.
