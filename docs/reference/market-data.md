# Market data

What the desk reads from Delta Exchange India, and what it keeps. The order
and account endpoints, and what their error codes mean, are in
[delta-api.md](delta-api.md); every table's columns are in [schema.md](schema.md).

REST `https://api.india.delta.exchange/v2`, socket
`wss://socket.india.delta.exchange`. Checked against the code on 30 Sep 2026.

---

## Live

| Data | Source | Cadence | Code |
|---|---|---|---|
| **The option board**: every BTC call and put -- mark, last, bid / ask and sizes, mark / bid / ask IV, the five greeks, OI, 24 h volume, spot | socket `v2/ticker` (`symbols: ['all']`); REST `/tickers?contract_types=call_options,put_options` as cold start and fallback | socket real time; REST every **8 s** | [delta-socket.ts](../../app/server/src/market/delta-socket.ts), [delta.ts](../../app/server/src/market/delta.ts) |
| **The perpetual's tape**: every BTCUSD and option print, by aggressor side | socket `all_trades` | real time, held for an hour | [flow-socket.ts](../../app/server/src/market/flow-socket.ts) |
| **The perpetual's ticker**: mark, funding, OI, turnover | socket `v2/ticker` on `BTCUSD` | real time | same |
| **The perpetual's book**, 500 levels a side (about ±1.2%) | REST `/l2orderbook/BTCUSD` | every **10 s** | [book-heat.ts](../../app/server/src/market/book-heat.ts) |
| **BTC spot** | REST `/tickers/BTCUSD` | on demand | [delta.ts](../../app/server/src/market/delta.ts) |
| **Contracts**: expiry, tick size, contract value (0.001 BTC), state | REST `/products` | on demand | [chain.ts](../../app/server/src/market/chain.ts), [exchange/delta.ts](../../app/server/src/trading/exchange/delta.ts) |
| **The account** (signed): balance, positions, open and past orders | `/wallet/balances`, `/positions/margined`, `/orders`, `/orders/history`, `/orders/{id}` | polled | [exchange/delta.ts](../../app/server/src/trading/exchange/delta.ts) |

## Historical

Delta serves history only as candles, from `/history/candles`, one symbol at a
time; a symbol prefix chooses what the candle is *of*.

| Data | Symbol | Resolutions |
|---|---|---|
| BTC OHLCV | `BTCUSD` | `1m 5m 15m 30m 1h 2h 4h 6h 1d`. **No `12h`** -- it returns nothing (measured 26 Sep 2026); the desk folds pairs of 6h bars. |
| Option OHLCV (traded price) | the contract, e.g. `C-BTC-80000-190926` | `1m` |
| Option mark | `MARK:<contract>` | `1m` (desk, harvester), `15m` (research) |
| Option open interest | `OI:<contract>` | `15m` (research) |

**There is no history of greeks, IV, bid / ask or the order book.** Delta
publishes those live only. For a past moment the desk works greeks and IV out
itself (Black-Scholes, `domain/bs.ts`), and for anything it wants to look back
on it keeps its own record -- below.

Not captured: **liquidations** (not a public feed on Delta; a burst of large
one-sided prints with OI falling is the visible trace), and per-strike history
beyond the two nearest expiries (every live contract would be ~16 GB a year).

## What the desk keeps

In PostgreSQL. Retention is enforced as each recorder writes.

| Table | What | Grain | Kept |
|---|---|---|---|
| `option_snapshots` | every strike of the two nearest live expiries: quotes, IV, greeks, OI, volume, spot | 5 min | 90 days (~16 MB a day) |
| `option_snapshots_1m` | the same, for the premium's last-minute velocity | 1 min | 6 hours |
| `oi_snapshots` | OI per strike, with spot and ATM IV | 5 min | 48 hours |
| `chain_features` | the board summarised: straddle, skew, PCR, walls, max pain, OI change | 5 min | 400 days |
| `trade_flow_1m` | the perpetual's tape per minute by aggressor side, large-print counts | 1 min | a year |
| `large_prints` | every perp taker order of 200 contracts (0.2 BTC) or more | per order | a year |
| `option_flow_1m` | the options' own tape, per contract per minute, by aggressor side | 1 min | 31 days |
| `perp_snapshots` | perp mark, funding, OI, turnover, top of book | 5 min | a year |
| `book_heat_1m` | the perp's book, averaged per $10 bin per minute | 1 min | 14 days |
| `index_1m` | BTC, and nothing else | 1 min | a year |

Every recorder writes `ON CONFLICT DO NOTHING` on its time key, so a restart or
a double timer cannot double a row, and a minute with no price stays a hole
rather than being filled with the last one. Why each is shaped as it is:
[database.md](database.md#market--what-the-board-looked-like-a-while-ago).

`chain.db`, the harvester's SQLite dataset -- settled option chains, intraday
mark paths and BTC's measured move distribution -- is described in
[database.md](database.md#chaindb--the-evidence).
