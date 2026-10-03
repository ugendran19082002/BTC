# Delta Exchange API

Read from https://docs.delta.exchange (verified and updated October 2026).
Covers all endpoints, transports, error semantics, order placement, order tracking,
and market data feeds this desk depends on.

Base URL: `https://api.india.delta.exchange`.
Signing: `api-key`, `signature`, `timestamp`, `User-Agent` headers — see `app/server/src/delta/signed.ts`.

---

## 1. Authentication & Signing Transport

- **HMAC-SHA256**: Signature computed as `HMAC-SHA256(secret, method + timestamp + path + query + payload)`.
- **Headers**:
  - `api-key`: User's Delta API key.
  - `timestamp`: Unix timestamp in seconds (`Math.floor(Date.now() / 1000)`).
  - `signature`: Hex digest of HMAC-SHA256.
  - `User-Agent`: `btc-options-desk/1.0` (required to avoid 403 CDN blocks).
  - `Accept`: `application/json`, `Content-Type`: `application/json`.
- **Zero-leakage guarantee**: Credentials exist only in `app/server/.env` and are injected into `signed.ts`. They are never passed to error loggers, never returned in API responses, and never logged in console outputs.

---

## 2. Errors: Deliberate Refusal vs. Outage / Silence

Delta errors fall into two fundamentally different classes:

### A. Deliberate Refusal (HTTP 4xx with JSON error code)
`{ success: false, error: { code: string, context?: unknown } }`
- **Meaning**: Delta received, processed, and deliberately rejected the request.
- **Handling**: Throws `DeltaRefused(status, code, message, detail)`.
- **Rule**: For a write (order placement), a refusal means **the order definitely does NOT exist on the exchange**. It is safe to move on or report failure immediately. No retry needed.

### B. Outage or Silence (HTTP 5xx, timeouts, network drops, unreadable replies)
- **Meaning**: The request left the server, but Delta gave no definitive answer or crashed mid-flight.
- **Handling**: Throws `RequestTimedOut`, `UnreadableReply`, or `ExchangeUnavailable` (`deltaTrouble`).
- **CRITICAL TRADING RULE**: **Silence is NOT an answer.** For any write (order placement or edit), silence means the order **MAY OR MAY NOT HAVE BEEN CREATED**. The engine marks the state as `unknown` and queries the exchange back; it **NEVER resends blindly**, which would cause duplicate fills and dangerous double exposure.

---

## 3. Order Placement — `POST /v2/orders`

Implemented in `app/server/src/trading/exchange/delta.ts` (`orderBody` and `send`).

### Required Payload Fields
```json
{
  "product_id": 151997,
  "size": 1,
  "side": "sell",
  "order_type": "limit_order",
  "time_in_force": "gtc",
  "reduce_only": false,
  "client_order_id": "409261789344005840"
}
```

### Best Practice Rules for Orders:
1. **Precision as String**: Prices (`limit_price`, `stop_price`) are sent as strings to preserve full tick precision across JSON serialization.
2. **`product_id` over `product_symbol`**: Delta's schema treats `product_id` and `product_symbol` as alternatives; sending both triggers `bad_schema` validation errors. Always send `product_id`.
3. **`reduce_only` must be boolean**: Sent as boolean `true` / `false`, never string `"true"`.
4. **Option Stop-Loss: Why Stop-Limit with Mark Trigger is Mandatory**:
   - Bare `market_order` stops on illiquid options are rejected by Delta with code `unsupported` (*"Market order couldn't be validated for price impact as orderbook data isn't available"*).
   - **Solution**: Option stops are placed as `stop_limit` orders with `stop_order_type: 'stop_loss_order'`, `stop_trigger_method: 'mark_price'`, and `limit_price` priced through the trigger (50% past trigger or 5 ticks). Delta accepts and validates this even when the order book has zero bids/asks.
5. **Unpriceable Market Exits**: If a reduce-only market exit returns `unsupported` or `no_liquidity_for_market_order`, it is retried once as an aggressive limit order through the touch under the same `client_order_id`. Entries are never retried this way — only exits.

---

## 4. Edit Order — `PUT /v2/orders`

Fields: `id`, `product_id`, and any of `limit_price`, `stop_price`, `size`.

### Book Removal Codes (`OrderGone`)
When editing resting orders, two specific return codes mean **the order has already left the book**:
| Code | Meaning | Desk Handling |
|---|---|---|
| `open_order_not_found` | Order no longer among open orders (filled or cancelled) | Maps to `OrderGone` -> reads order back to record fill |
| `order_already_filled` | Order has completely filled and cannot be edited | Maps to `OrderGone` -> reads order back to record fill |

Every other edit failure is treated as `OrderRejected`.

---

## 5. Cancel Order — `DELETE /v2/orders`

Body: `{ id: number, product_id: number }`.
- If Delta responds with a refusal (e.g. order not found / already cancelled), the cancel succeeds silently because the desired end state (order off the book) is already achieved.
- If Delta responds with a 5xx/outage, `ExchangeUnavailable` is thrown so the caller verifies the book.

---

## 6. Order Lookup Hierarchy (`getOrderByClientId`)

Because Delta splits live and closed orders across different endpoints, and because `/v2/orders/history` ignores the `client_order_id` parameter, the desk employs a 4-tier lookup strategy:

1. **Direct Client ID Endpoint (`GET /v2/orders/client_order_id/{client_order_id}`)**:
   - Queries Delta's direct client ID route. Fast single-call lookup for open or filled orders.
2. **Live Open Book (`GET /v2/orders?client_order_id=...&states=open,pending`)**:
   - Checks resting orders.
3. **Recent History Scan (`GET /v2/orders/history?page_size=20`)**:
   - Scans the account's newest 20 closed orders.
4. **Deep Contract History (`GET /v2/orders/history?product_ids={productId}&page_size=200`)**:
   - For orders past the newest 20 on busy accounts, queries the specific contract history using the documented numeric `product_ids` filter.
   - **Rate Limit Throttling (`deepMiss`)**: Missed deep lookups are cached with a 30-second cooldown (`DEEP_RETRY_MS = 30_000`) so missing orders do not consume the 10-weight quota on every second's poll.
5. **Lookup by Exchange ID (`GET /v2/orders/{id}`)**:
   - Direct lookup by Delta's numeric order ID (answers open or closed). 404 is the only response that definitively confirms "no such order".

---

## 7. Account Balances & Positions

### Balances (`GET /v2/wallet/balances`)
- `balance`: Total FNO account value / wallet balance.
- `available_balance`: Free margin available to trade.
- Margin in use is `balance - available_balance`.

### Margined Positions (`GET /v2/positions/margined`)
- Returns `size`, `entry_price`, `unrealized_pnl`, `mark_price`, `liquidation_price`.
- The desk uses Delta's native mark and unrealized PnL figures to guarantee 100% agreement with the exchange screen.

---

## 8. Rate Limits & Quotas

- **Window**: 20,000 units per fixed 5-minute window per user ID (signed) / IP (public).
- **Weights**:
  - `1`: Unlisted / lightweight endpoints
  - `3`: Products, order book, tickers, open orders, open positions, balances, candles
  - `5`: Place / Edit / Delete order, add position margin
  - `10`: Order history (`/v2/orders/history`), fills, transaction logs
  - `25`: Batch order APIs
- **HTTP 429 Handling**: Returns `X-RATE-LIMIT-RESET` in milliseconds. `signed.ts` parses this and throws `RateLimited(resetMs)`, causing risk gates and engine loops to pause cleanly until reset.

---

## 9. Public Market Data & WebSocket Feeds

### Ticker Stream (`app/server/src/market/delta-socket.ts`)
- **Current URL**: `wss://socket.india.delta.exchange`.
- **Channel**: `v2/ticker` (sends full ticker JSON with greeks and quotes).
- **Batching & Smoothing**: Inbound updates are accumulated in memory and dispatched at most once per second (`SNAPSHOT_MS = 1_000`).
- **Pre-filtering**: Unparsed string filter `looksLikeBtcOption` drops non-BTC products immediately before JSON parsing.
- **Upcoming New Endpoint**: Delta's new socket endpoint `wss://public-socket.india.delta.exchange` uses channel `ticker` with compact keys (`i`, `m`, `oi`). Migration will happen when Delta dates the legacy socket deprecation (tracked in [TODO.md](../TODO.md)).

