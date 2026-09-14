# Delta Exchange API — what this desk relies on

Read from https://docs.delta.exchange on 14 Sep 2026 (changelog then headed
31.08.26). Only the parts this desk's code depends on, each with where the
dependency lives. Re-read the live docs before changing any of it; the
changelog is dated and short.

Base URL: `https://api.india.delta.exchange`. Signing: `api-key`, `signature`,
`timestamp` headers — see `src/delta/signed.ts`.

## Errors

Every refusal is `{ success: false, error: { code, context } }` with an HTTP
4xx. The `code` is what the code branches on; `context` names the field.
`signed.ts` turns this into `DeltaRefused(status, code, message, detail)`.

HTTP-level: 400 invalid request · 401 bad key or signature · 403 blocked by
CDN (a missing `User-Agent`, or a hosted IP) · 404 · 405 · 406 not JSON ·
429 rate limit · 500 server error · 503 maintenance.

**Delta's own failure is not an answer.** 500/503, a timeout, or an unreadable
body say nothing about whether the request was acted on. `signed.ts` throws
`RequestTimedOut` / `UnreadableReply` for those; the engine treats a write that
ends that way as *unknown* and goes and reads the order back, never resends.
A 4xx with a code is Delta saying no on purpose, once. (`read-retry.test.ts`)

### Edit order — `PUT /v2/orders`

Fields: `id`, `product_id` (or `product_symbol`), then any of `limit_price`,
`size`, `stop_price`, `trail_amount`, `mmp`, `post_only`. Editing re-runs the
*place* risk checks against the modified order with the original excluded from
the book, so every place-order code can come back from an edit too.

Two codes mean **the order is no longer on the book**, not that the edit was
wrong:

| code | Delta's wording |
|---|---|
| `open_order_not_found` | couldn't be found among open orders — it may already be filled or cancelled |
| `order_already_filled` | has already been completely filled and can no longer be edited |

`exchange/delta.ts` maps both to `OrderGone`; the engine reads the order again
and records the fill instead of reporting a failure. This is the 14 Sep
"add chase failed" line — a 650-contract add that filled five seconds after it
was sent, one chase step behind. Every other edit refusal is `OrderRejected`.

Codes worth recognising by name when they appear in the error log:

- `insufficient_margin`, `insufficient_commission` — the account, not the order.
- `immediate_execution_post_only` — a post-only order priced through the book.
  Relevant if `post_only` is ever sent (TODO.md lists it as not yet used).
- `overlapping_buy_sell_orders` — would self-trade against a resting order of
  ours on the other side. The reduce-only target and stop sit on the buy side
  of a short, so an *add* priced at or under them would hit this.
- `naked_short_restricted`, `greeks_limits_breached`, `risk_limits_breached`,
  `account_risk_limits_breached` — limits on the account's options book.
- `no_position_for_reduce_only`, `no_position_left_for_reduce_only` — a
  reduce-only order (target, stop, close) after the position is already flat.
- `reduce_only_orders_allowed`, `liquidation_risk_limits_breached` — only
  closing is allowed right now.
- `max_orders_count_exceeded` — too many open orders on the account.
- `stale_order`, `invalid_contract` (expired product), `trading_blocked`.

### Cancel — `DELETE /v2/orders`

Body `{ id, product_id }`. A refusal on a cancel means the order is not open
to cancel — already filled or already cancelled — which is the state a cancel
wanted; `delta.ts` returns quietly on `DeltaRefused` and throws only on
Delta's own failure (`ExchangeUnavailable`), so the caller goes and checks.

### Reading orders back

- `GET /v2/orders?client_order_id=…&states=open,pending` — live orders only.
  `states` accepts only `open` and `pending`.
- `GET /v2/orders/history` — cancelled and closed. Weight 10.

A filled or cancelled order is **absent** from the first and present only in
the second, so `getOrderByClientId` asks both — asking the first alone reads a
filled order as "never existed", the most dangerous wrong answer after a submit
that timed out. (`exchange/delta.ts`, `read-retry.test.ts`)

### Rate limits

20,000 units per fixed 5-minute window, per user id for signed requests, per
IP for public ones. 429 carries `X-RATE-LIMIT-RESET` in milliseconds and
`signed.ts` throws `RateLimited(reset)`.

| weight | endpoints |
|---|---|
| 1 | anything not listed |
| 3 | products, orderbook, tickers, open orders, open positions, balances, candles |
| 5 | place / edit / delete order, add position margin |
| 10 | order history, fills, transaction logs |
| 25 | batch order APIs |

Product-level: 500 operations per second per product. The desk polls every
20 s (`TICK_MS`) and the chain route on the browser's own interval, well inside
both; a burst — a reconnect, several tabs — is what the 429 handling is for.

## What is not used, and could be

Documented and unused by this desk: `post_only`, `time_in_force: ioc`, bracket
orders (`Place Bracket order`, `Edit Bracket order`), batch create/edit/delete,
trailing stops (`trail_amount`), and `mmp`. TODO.md's "Execution controls the
desk does not have yet" and "Use Delta's bracket endpoint for protection"
cover the case for each.
