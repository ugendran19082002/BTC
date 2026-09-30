# TODO

Open work only, most important first within each group. Each item says why it
matters and where the long form is. Finished work and the record of how things
broke is in [history/2026-09.md](history/2026-09.md); an item moves there
(ticked) when it is done.

Updated 30 Sep 2026 (evening): 25 items closed that afternoon -- see the history's
"30 Sep 2026 (afternoon)" entry.

---

## Entry section -- 24 entry setups

Built 30 Sep 2026: the twelve entry methods of `TEST.md`, each read **with the
timeframe chain** and **without it** -- 24 setups -- on the desk tab, drawn and
paper-logged, no orders. How it works: [features/entry-setups.md](features/entry-setups.md);
why no orders: [decision 0013](decisions/0013-entry-setups-measured-before-trusted.md).
The record of what was built is in [history/2026-09.md](history/2026-09.md).

| # | Method | With timeframe | Without timeframe |
|---|---|---|---|
| 1 | Breakout | [x] | [x] |
| 2 | Breakout + retest | [x] | [x] |
| 3 | Liquidity sweep | [x] | [x] |
| 4 | FVG retest | [x] | [x] |
| 5 | Order-block retest | [x] | [x] |
| 6 | BOS | [x] | [x] |
| 7 | MSS / CHoCH | [x] | [x] |
| 8 | Momentum | [x] | [x] |
| 9 | Pullback | [x] | [x] |
| 10 | VWAP / mean reversion | [x] | [x] |
| 11 | Order flow | [x] | [x] |
| 12 | Options / derivatives | [x] | [x] |

Still open:

- [ ] **Deploy it** (with the rest of 30 Sep): the log only starts once it runs.
- [ ] **Read the log after a month** (end of October 2026): per method, with vs
  without the timeframe chain -- trades, win rate, average R after fees. Judge
  on data the thresholds were not tuned on. Nothing gets an alert or an order
  button without a positive record over enough trades.
- [ ] **On 5m almost everything is refused for fees** (live, 30 Sep: all 24 NO
  TRADE, mostly "R:R after fees, no room"). If the owner wants a timeframe the
  structure can pay for, log the without-timeframe reads at 15m / 1H too (one
  line in `index.ts`), and compare.
- [ ] **Footprint recorder** (volume per price per minute): method 11 reads
  absorption from delta against price until it exists; the score's footprint
  part scores nothing.
- [ ] **A calibrated probability** for the score's last 5 points -- only from the
  log, once there is one. Until then it scores nothing and says so.
- [ ] The timeframe weights (5/10/10/15/30/15/15), R:R 1.8 and the 0.3-2.5 ATR
  stop band are TEST.md's design, not measurements; revisit with the log.
- [ ] `npm run test:responsive` on the desk tab with the entry section (needs a
  running app).
- [x] **Hard-gate checklist** on screen (30 Sep 2026): a "Gates · without / with"
  column pair in the Entry methods table ("✓ 6/6" or the gate that refuses), and
  every gate's rule, value and ✓ / ✗ / – in each panel.
- [x] **Gates switchable** (30 Sep 2026): each gate on / off from the entry
  section (Data fresh locked on), stored in `entry_gates` with a change log;
  setups logged with a gate off carry `gates_off` and are kept out of the record.
- [x] **Auto-select and Telegram for entry setups** (30 Sep 2026): a new
  signal chooses its row (AUTO), the chosen row is highlighted; each way has a
  Telegram switch, off by default, one message per setup.
- [ ] **Telegram for the entry setups needs `TG_TOKEN` / `TG_CHAT_ID` on the
  server** -- the same ones the fill alerts use. After the deploy, switch a way
  on and press *test* once to see it arrive.
- [x] **Every signal saved on the server** (30 Sep 2026): `entry_signals`
  journal (every WAIT and TRADE, every timeframe, one row per setup per state,
  kept a year) and the paper log on every timeframe, not only 5m.
- [x] **Entry range, stop and targets corrected** (30 Sep 2026): zones at most
  0.5 ATR at the fill edge (FVG / OB were the whole gap / candle, up to 689
  pts); risk measured from the fill; FVG stop at the gap's far edge; each
  target 0.5 ATR past the last; entry drawn blue with R and points on every line.
- [x] **Live LTP and latency** (30 Sep 2026): the execution step reads the
  tape's last trade; a TRADE card shows LTP, where it is against the zone and
  points to entry / SL / TP1 on every tick; board every 5 s (cache 3 s);
  recorder 3 s after each 1m close.
- [ ] **Grade fills from the tape, not 1m candles**: the paper log fills on 1m
  OHLC (a candle touching stop and TP1 is the stop). The recorded prints
  (`trade_flow_1m` is per minute; the raw prints are held 65 min in memory)
  would say which came first -- needs a per-print record to replay.
- [ ] **A signal log on screen**: `GET /api/entry/signals` is there; a table
  of the day's signals (time, method, way, timeframe, WAIT / TRADE, how long
  it stood, what became of it) under the paper record.
- [ ] **Telegram per timeframe**: alerts are the chain and 5m without it; if
  the owner wants 15m / 1H alerts, a choice of timeframes per way.
- [ ] **Re-run the replay** (`scripts/entry-study.ts`) on the corrected zones,
  stops and targets: the 30 Sep numbers were taken on the old ones.
- [ ] **Read the gate switches with the log**: a month of setups with every gate
  on is the record; anything logged with one off is counted apart
  (`gatesOff`). Before trusting a gate-off result, it needs its own month.
- [ ] **R&D finding -- R:R after fees is the gate that refuses most** (May-Aug
  2026 replay, 35,124 5m bars): 9-74% of each method's reads. On 5m the round
  trip in fees (~84 pts at $84k) is about one ATR. Log the without-timeframe
  reads at 15m / 1H too and compare (one line in `index.ts`), rather than
  lowering 1.8.
- [ ] **R&D finding -- Liquidity sweep's stop is usually too wide**: 39% of its
  reads refused for a stop over 2.5 ATR (the sweep low to the MSS level). Decide
  with the owner whether its entry should be nearer the sweep; do not change it
  before the paper log has a month.
- [ ] **The replay cannot test methods 11 and 12, nor the with-timeframe 3m / 1m
  steps**: there is no recorded tape, option board or 1m history for 2024-26.
  Keep recording; re-run `scripts/entry-study.ts` once there is a quarter.
- [ ] **The trend plan's paper log is no longer on screen** (the chart lost it
  on 30 Sep with its own entry logic). It is still written; its review at the
  end of October reads `GET /api/trend/paper` or `trend_paper` directly --
  or it gets a place in the entry section's records, if the owner wants it.

## Needs the owner

- [ ] **Deploy.** Nothing from 30 Sep is live: the desk runs `btc-desk-api:ed5f22d`
  (29 Sep), older even than the backstop stop (`4fc4551`). Deploy with nothing
  open ([guides/deploy.md](guides/deploy.md)), then run `deploy/refresh.sh` once
  so the desk gets the backfilled `chain.db` (756 days, to 29 Sep) and the
  reload goes through.
- [ ] **One-lot live test: two strategies on one contract.** The engine now keeps
  each trade's orders and position apart ([decision 0011](decisions/0011-one-trade-per-contract.md)),
  tested on the paper exchange only. Whether Delta holds two reduce-only
  targets and two stop triggers on one contract is the venue's answer
  ([decision 0002](decisions/0002-simulator-is-not-the-venue.md)). Two
  strategies, one lot each, same strike, watched.
- [ ] **Set the 17:01 strategy's own minimum premium**, if it is to trade like
  AlgoTest: Strategy -> Sell -> "Its own minimum premium". Off by default; the
  desk's $5 applies until it is set.
- [ ] **Stop the retired analytics container**: `btc-desk-analytics-1` is still
  running, 22 h after the service was retired and removed from compose.
  `docker rm -f btc-desk-analytics-1`.
- [ ] **Rotate the credentials pasted in chat** (Delta API key, desk password,
  Telegram token -- [security audit](history/2026-09-11-security-audit.md) #14),
  and confirm `DESK_SESSION_SECRET` is 32 random bytes (#15). Only you can.
- [ ] **Two files in public git history.** `b5ab025` (auto-committed and pushed
  30 Sep) holds `harvester/chain.db.bad-presettlement-20260930`, 122 KB of
  harvested market prices, no credentials; `34383e4` holds a Delta
  trade-history CSV with order ids. Removed from the tree; rewriting history
  (and force-pushing) is your decision. `.gitignore` now covers any `chain.db*`.
- [ ] **Review the trend plan's paper log** on 31 Oct 2026, then monthly: live
  1H / 4H trades, net R after fees, the two pre-registered filters. Drop the
  plan if it is negative after ~40 live trades.
- [ ] **The refresh cron** runs at 12:40 IST, before the 17:30 settlement, so each
  day arrives a day late (the harvester now skips an unsettled day rather than
  storing it wrong). 18:10 IST would take the same day. It is your crontab.

## Trading engine and strategies

- [ ] **Delta's stop direction is still unverified** live. One deliberate
  one-lot test. The take-profit was "conventional" too, until 9 Sep.
- [ ] **One live test of a stepped exit** with one lot: a stage moving a real
  Delta target / stop in place.
- [ ] **Execution controls not used yet**: `post_only`, `time_in_force: ioc`,
  `trail_amount`, bracket orders; and reconciling against
  `/v2/orders/history` as well as the open book. Each needs a live test of its
  own. See [reference/delta-api.md](reference/delta-api.md).
- [ ] **The two premium floors differ**: 5 in the trading gate, 15 as the chain's
  default filter. One is a gate and one a view; decide whether they should be
  one number.
- [ ] **A shared contract's position is checked on reconcile, close and add only**,
  not on every poll (as for a single trade). A gap nobody can attribute is said
  after a minute of it -- but only once one of those runs.

## Market data and the database

- [ ] **Delta's new public socket speaks a different protocol.** Checked 30 Sep:
  `public-socket.india.delta.exchange` refuses `v2/ticker` and `all_trades`
  ("subscription forbidden on this invalid channel") and sends `ticker` in a
  compact format. Moving means rewriting both socket parsers; do it when Delta
  dates the old socket's end. [reference/delta-api.md](reference/delta-api.md).
- [ ] **Off-host copies of the database dumps.** `backups/` is on the same disk.
- [ ] **Drop the retired SQLite files** from the `data` volume after 19 Oct 2026.
- [ ] **Next recorders**: footprint (volume per price per minute) and wall
  events (pulled / filled / moving); an OI / ΔOI / funding pane from
  `perp_snapshots`.

## Research

- [ ] **Measure the volatility risk premium** on the desk's own record: implied
  against realised by expiry, net of fees, 2024-26. Every directional rule
  tested on BTC 5m-4H is ~0 after fees; this is the documented edge for an
  option seller. See [research/findings.md](research/findings.md).
- [ ] **Test the order-flow layers** once recorded long enough -- flow from
  December 2026, the book and big trades early 2027 -- base first, then one
  layer at a time, declared before looking.
- [ ] **OI / volume / chain / early-warning as confirmations**: earliest honest
  look around December 2026.
- [ ] **The spread each scheduled entry sold into** is now in `strategy_runs.detail`
  ("…, ask X"). After a month of it, set `maxCrossSpreadPct` from it.
- [ ] If direction is ever traded, the research points at 15m / 1H, not 5m.
- [ ] Untested ideas, in the order the data allows: funding / basis carry,
  liquidation-cascade reversal, BTC-ETH SMT, footprint absorption
  ([research/ideas.md](research/ideas.md)). SMC / ICT / CRT: stop -- 30+
  variants tested, none held.

## Screen

- [ ] **Chart data-failure states** (gap, duplicate, stale feed) drawn as
  "DATA UNAVAILABLE" rather than candles on bad data.
- [ ] **A candle touching both stop and target** is resolved as the stop;
  resolve it from 1m candles.
- [ ] Setup history saved to the database (a table, on a go-ahead for its
  schema).
- [ ] The order ticket is long on a phone; the chain scrolls sideways on one.
- [ ] The swipe-to-confirm has no touch-only path for a screen reader.
- [ ] `styles.css` (~3,400 lines) is the most-churned file in the repo.

## Security and operations

- [ ] HSTS `includeSubDomains` / `preload`, once every `thannigo.in` subdomain is
  HTTPS (audit #16).
- [ ] `deploy/btc-desk-api.service` is a pre-docker systemd unit nothing uses.
  Keep for a host without docker, or delete.

## Code hygiene

- [ ] The web suite's 5 s per-test timeout is tight on a 4-vCPU box that also
  runs the desk.
