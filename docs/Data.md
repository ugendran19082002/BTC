Here's what the desk gets from Delta's API, split into live and historical, with timeframes, plus where each piece is stored. I took it from the code that calls Delta (market/delta.ts, delta-socket.ts, chain.ts, moves.ts, the harvester and the research scripts).

1. Live data (present)
Data	Endpoint / channel	How often	Fields
Option chain (every BTC call and put)	WebSocket v2/ticker (all symbols); REST /v2/tickers?contract_types=call_options,put_options as backup	Real-time over the socket; REST poll every 8 s	strike, call/put, mark price, last traded price, spot, OI (oi, oi_contracts), 24h volume
Greeks	same ticker	real-time	delta, gamma, theta, vega, rho
Quotes and IV	same ticker	real-time	best bid / best ask, bid size, ask size, mark IV, bid IV, ask IV
BTC spot (index)	/v2/tickers/BTCUSD	when needed	spot price, mark price
Contracts and expiries	/v2/products	when needed	expiry, tick size, contract value (0.001 BTC), state (live/expired)
Your account (signed)	/v2/wallet/balances, /v2/positions/margined, /v2/orders, /v2/orders/history, /v2/orders/{id}	on demand / polled	balance, positions, open orders, filled and cancelled orders
2. Historical data (past)
Delta returns history only as candles, from /v2/history/candles:

Data	Symbol	Timeframes we use	How far back we ask
BTC OHLCV	BTCUSD	1m, 5m, 15m, 1h, 4h, 1d	Chart: 1m 8 h · 5m 36 h · 15m 4 days · 1h 14 days · 4h 60 days · 1d 150 days. Trend readings: 220 bars per timeframe.
Option OHLCV (traded price)	the contract, e.g. C-BTC-80000-190926	1m	the last 8 h at the moment being looked at
Option mark price	MARK:<contract>	1m (desk), 15m (research)	1 h window (desk), whole day (research)
Option open interest	OI:<contract>	15m	whole day (research harvest)
Delta keeps no history of the greeks, IV, bid/ask or order book. You can only get those live. For past dates the desk calculates the greeks and IV itself with Black-Scholes, and it records its own snapshots, listed in section 3.

Delta also offers data we don't use yet: the order book (l2_orderbook), the trades feed (all_trades) and funding rates.

3. Where it's stored, with timeframes
PostgreSQL (btc_desk, the live desk)

Table	What	Timeframe	Kept for	Rows now
oi_snapshots	OI per strike, plus spot and ATM IV	5 min buckets	48 hours	11,980
chain_features	whole-chain summary: PCR (OI and volume), call/put OI, IV skew, OI walls, max pain, 1-hour OI change	5 min	400 days	117 (recording started 17 Sep)
mtm_samples	today's P&L: realised, unrealised, charges, net	1 min	90 days	6,360
trades, trade_events	your trades and every fill, order and exit	per event	forever	82 / 629
outlook_states, chain_states	measured Down/Side/Up odds per horizon	measured from 5-min bars; horizons 5m to 24h	until the next publish	90 / 0
strategies, strategy_*, settings, auth_*, errors	desk records, not market data	per event	—	—
SQLite chain.db (history built by the harvester, 735 days: 4 Sep 2024 to 8 Sep 2026)

Table	What	Timeframe
days	spot at the 05:30 IST entry, settlement price, ATM strike, strike step	1 row per day
legs	every strike: last traded price, mark, age of last trade, 8-hour volume, settlement value	daily, at 05:30 IST (27,444 rows)
paths	each leg's journey from entry to settlement: low/high and when, how fast it decayed or spiked	hourly marks (13 per day) plus minute-level low/high timing
oi	OI at entry, 8 hours earlier, the change, and its acceleration	at entry, measured over 8 h / 2 h
calibration	model probability compared with what actually happened	derived from all days
horizons	how far BTC actually moves	5m, 15m, 1h, 2h, 3h, 4h, 6h, 12h (from 105,120 five-minute windows)
The main gap: there's no stored intraday history of the greeks or IV per strike. chain_features has recorded the chain every 5 minutes only since 17 September, and oi_snapshots keeps just 48 hours. If you want per-strike greeks, IV and bid/ask kept long-term (say every 5 minutes for a year), that would be a new table fed from the live ticker, and I can add it.