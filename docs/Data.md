# Market data — what Delta gives, and what the desk keeps

What this desk reads from Delta Exchange India's API, live and historical, at
which timeframes, and where each piece ends up. For the order and account
endpoints and their error codes, see `DELTA-API-NOTES.md`; for every column of
every table, `DB-INVENTORY.md`.

Base URL `https://api.india.delta.exchange`, socket `wss://socket.india.delta.exchange`.
Read from the code on 19 September 2026.

---

## 1. Live (present)

| Data | Endpoint / channel | Cadence | Fields | Code |
|---|---|---|---|---|
| **Option chain** — every BTC call and put | WebSocket `v2/ticker`, `symbols: ['all']`; REST `/v2/tickers?contract_types=call_options,put_options` as cold start and fallback | **Real time** on the socket; REST poll every **8 s** | strike, call/put, **mark price**, last traded price (`close`), **spot**, **OI** (`oi`, `oi_contracts`), **24 h volume** | `market/delta-socket.ts`, `market/delta.ts` |
| **Greeks** | same ticker | real time | **delta, gamma, theta, vega, rho** | same |
| **Quotes and IV** | same ticker | real time | **best bid / best ask**, bid size, ask size, **mark IV, bid IV, ask IV** | same |
| **BTC spot (index)** | `/v2/tickers/BTCUSD` | on demand | spot price, mark price | `market/delta.ts` |
| **Contracts and expiries** | `/v2/products` | on demand | expiry, tick size, contract value (0.001 BTC), state (live / expired) | `market/chain.ts`, `trading/exchange/delta.ts` |
| **Account** (signed) | `/v2/wallet/balances`, `/v2/positions/margined`, `/v2/orders`, `/v2/orders/history`, `/v2/orders/{id}` | on demand / polled | balance, positions, open orders, filled and cancelled orders | `trading/exchange/delta.ts` |

---

## 2. Historical (past)

Delta serves history only as candles, from `/v2/history/candles`, one symbol at
a time. A symbol prefix chooses what the candle is *of*.

| Data | Symbol | Timeframes used | Span requested | Code |
|---|---|---|---|---|
| **BTC OHLCV** | `BTCUSD` | **1m, 5m, 15m, 1h, 4h, 1d** | Chart: 1m 8 h · 5m 36 h · 15m 4 d · 1h 14 d · 4h 60 d · 1d 150 d. Trend readings: 220 bars per timeframe. | `http/routes/desk.routes.ts` (`/api/candles`), `market/moves.ts` |
| **Option OHLCV** (traded price) | the contract, e.g. `C-BTC-80000-190926` | **1m** | the 8 h before the moment being looked at | `market/chain.ts` (`historicalChain`), `harvester/harvest_chain.py` |
| **Option mark price** | `MARK:<contract>` | **1m** (desk, harvester), **15m** (research) | 1 h before the moment (desk); the whole day (research) | same, `research/harvest.py` |
| **Option open interest** | `OI:<contract>` | **15m** | the whole day | `research/harvest.py`, `research/harvest_oi.py` |

**There is no history of greeks, IV, bid/ask or the order book.** Delta
publishes those live only. For a past moment the desk works the greeks and IV
out itself (Black-Scholes, `domain/bs.ts`), and for anything it wants to look
back on later it keeps its own snapshots — section 3.

Offered by Delta and not used here: the order book (`l2_orderbook`), the trades
feed (`all_trades`), funding rates.

---

## 3. What the desk keeps, and at what timeframe

### PostgreSQL `btc_desk` — the live desk (schema `public`)

Row counts read on 19 Sep 2026.

| Table | What | Timeframe | Kept | Rows |
|---|---|---|---|---|
| `oi_snapshots` | OI per strike, with spot and ATM IV | **5 min** buckets | 48 h | 11,980 |
| `chain_features` | the whole board summarised: PCR (OI and volume), call / put OI, IV skew, OI walls, max pain, OI change over the hour | **5 min** | 400 days | 117 — recording since 17 Sep 2026 |
| `mtm_samples` | the day's P&L: realised, unrealised, charges, net | **1 min** | 90 days | 6,360 |
| `trades`, `trade_events` | the desk's trades, and every order, fill and exit | per event | permanent | 82 / 629 |
| `outlook_states`, `chain_states` | measured Down / Side / Up odds per state and horizon | measured on 5-min bars; horizons 5m – 24h | until the next publish | 90 / 0 |
| `strategies`, `strategy_*`, `settings`, `auth_*`, `errors` | desk records, not market data | per event | — | — |

### SQLite `chain.db` — the history the harvester built

735 days, 4 Sep 2024 – 8 Sep 2026. Built by `harvester/harvest_chain.py`,
topped up daily by `deploy/refresh.sh`, read-only at runtime.

| Table | What | Timeframe |
|---|---|---|
| `days` | spot at the 05:30 IST entry, settlement, ATM strike, strike step | **one row per day** |
| `legs` | every strike: last traded, mark, age of the last trade, 8 h volume, **value at settlement** | **daily, at 05:30 IST** — 27,444 rows |
| `paths` | each selected leg from entry to settlement: low and high and when, how fast it decayed or spiked | **hourly** marks (13 a day), low / high timed to the minute |
| `oi` | OI at entry, 8 h before, the change, its acceleration | at entry, over **8 h / 2 h** |
| `calibration` | the model's probability against what happened | derived from all days |
| `horizons` | how far BTC actually moves, 101 percentiles of the signed return | **5m, 15m, 1h, 2h, 3h, 4h, 6h, 12h** — from 105,120 five-minute windows |

---

## 4. The gap

Nothing keeps **per-strike greeks, IV or bid/ask over time**. `chain_features`
records a board-level summary every 5 minutes (since 17 Sep 2026) and
`oi_snapshots` keeps per-strike OI for only 48 h, so a question like "how did
the 80,000 call's IV move through the day" cannot be answered after the fact.

Closing it is a new table fed from the live ticker — per strike, every 5
minutes: mark, bid, ask, sizes, mark / bid / ask IV, the five greeks, OI and
volume — kept for as long as the history is wanted. Sized from `oi_snapshots`
(137 bytes a row with its index, for 7 columns; about 250 for this one):

| Scope | Rows a year | Disk a year |
|---|---|---|
| every live BTC contract (~610) | ~64 M | ~16 GB |
| the nearest expiry only (~100 strikes) | ~10.5 M | ~2.6 GB |

The nearest expiry is the one the desk trades, so it is the natural start.
Tracked in `TODO.md`.
