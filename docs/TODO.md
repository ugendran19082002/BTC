# TODO

Open work only, most important first within each group. Each item says why it
matters and where the long form is. Finished work and the record of how things
broke is in [history/2026-09.md](history/2026-09.md); an item moves there
(ticked) when it is done.

Updated 30 Sep 2026 (evening): 25 items closed that afternoon -- see the history's
"30 Sep 2026 (afternoon)" entry.

---

## Speed: one pass over the open trades

- [ ] **A pass polls the open trades one after another** (owner, 6 Oct 2026 evening: the phone's health card
  showed one pass of 9 s). Each trade is about three round trips to Delta, so a pass grows with the trades open
  (~0.4 s each). Perp SL/TGT do not wait on it -- the fast watch reads them ten times a second (4 Oct 2026) -- and
  every stop rests at Delta; what waits is noticing fills, exit times and the desk's own option-stop check. The
  fix is polling contracts side by side, which the 4 Oct audit left until it could be measured: read the pass
  times and Delta's quota on `/api/desk/metrics` with many trades open, then build it in a worktree (it is the
  order path), with the owner's go-ahead.

## Phone view and a phone-friendly desk

The phone (`/m`) has five tabs -- Home, P&L, Positions, Orders, More -- and Level 2 (runs, signals, trade detail,
the Telegram link, statistics), built 6 Oct 2026: see [history/2026-10.md](history/2026-10.md). Still open:

- [ ] **Deploy it and install it**: open `/m` on the phone, sign in, *Install app*. Check the session shows
  "view only" on the desk's profile page, and that the phone refuses nothing it should read.
- [ ] **Set `DESK_URL`** in the server's `.env` (e.g. `https://delta.thannigo.in`): until it is set, fill alerts
  carry no "Open this trade" link.
- [ ] **The whole desk phone-friendly** (owner, 6 Oct 2026): every screen, menu, card, field and icon of the
  full desk adapted to a phone -- sizes, padding, margins, touch targets, tables that become cards -- with no
  change to what any of it does; the owner's reference image for colours and spacing. Mobile first, desktop
  optional. Screen by screen (strategy, desk, trade, orders, pnl, methods, errors), measured at 360 / 390 / 430 px
  for sideways scroll with `app/web/scripts/responsive-check.mjs`, landed one screen at a time.
- [ ] **A light theme, only if wanted** (the owner's reference showed one as optional): the desk is dark only.
- [ ] **An APK, only if wanted**: wrap `/m` with Bubblewrap (a Trusted Web Activity); needs
  `/.well-known/assetlinks.json` served by nginx. The installed web app already does the same job.
- [ ] Later, once the read-only phone has proved itself: a TOTP-confirmed "stop new risk" switch (scheduler or
  one strategy off, never touching positions), and a passkey sign-in for the phone.

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

### R&D from the first paper log (owner, 1 Oct 2026)

The owner's read of the paper log so far (closed trades, R per trade). Small
samples are candidates to replay, not proven; the losers are the first work.
Desk numbers (1-81) with the research number in brackets.

- [ ] **#55 Pulled wall (64) -- the biggest loss.** 96 closed, -52.80R, win
  21.9%, PF 0.38. A wall pulled is not an entry by itself: make it a chain --
  wall pulled -> did price actually move? -> did aggressive flow confirm? ->
  did structure break? -> retest -> entry. Replay the chain against the
  current one-step trigger before keeping it on the desk.
- [ ] **#11 Order flow -- entry timing, not the targets.** 62 closed, -8.10R,
  yet the raw TP1/SL median is 2.04R: the target geometry is fine, so look at
  entry timing, confirmation, SL placement and false signals. Its own deeper
  study.
- [ ] **#4 FVG retest -- needs more than "price entered the gap".** 22 closed,
  -14.22R, average -0.65R, PF 0.21. Test adding an HTF level, displacement
  quality, FVG freshness, flow, an MSS and room to the target.
- [ ] **#2 Breakout + retest -- right R:R, still losing.** 29 closed, -14.01R,
  win 31%, TP1/SL median 1.71. R:R alone does not fix it: test false
  breakouts, late retests and the wrong regime (the `regime` kept on every
  signal).
- [ ] **Candidates to replay (positive, samples small):** #38 Engulfing +
  structure (43) 7 closed +11.80R, avg +1.69R; #37 Channel breakout (41) 14
  closed +4.60R, PF 1.65; #50 Gamma wall reaction (58) 8 closed +4.01R, PF
  2.32 -- the options-side logic further; #59 Footprint stacked continuation
  (73) 27 closed +5.27R, win 48.1%, PF 1.37 -- the order-flow family's lead;
  #54 Liquidity replenishment (63) 33 closed +3.79R, PF 1.19 -- split by
  regime and timeframe; #29 OI-confirmed breakout (32) 6 closed +1.73R. None
  is proven: replay each with the bar set before the run.
- [ ] **The SL/TP lesson.** Across these, a good TP1/SL ratio did not make a
  method pay: the entry -- its confirmation and timing -- decides. Every
  method's change above is judged on the paper log's average R and PF, with
  enough closed trades, not on its R:R.

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
- [x] **Signal history on screen** (30 Sep 2026): every kept signal with its
  levels and what became of it; filters; cards on a phone. The paper record
  says what is happening when empty, and shows gate-off setups apart.
- [x] **Telegram per timeframe, and every alert on record** (30 Sep 2026):
  the without-timeframe switch has timeframe chips (5m by default); every
  attempt is in `entry_alert_log` with sent / failed and why, and the switch
  shows the last one. (The owner's "one alert, then none": only one new 5m
  TRADE came between 19:25 and 20:00 -- the rest were 1m-4H, not alerted then.)
- [ ] **Six gates are switched off on the live desk** (spread, stop, R:R, HTF,
  big-move, expected move, as of 30 Sep 20:00): every TRADE since is logged
  "with a gate off" and kept out of the record. Turn them back on for the
  paper log to measure the rules as designed.
- [x] **Re-run the replay** on the corrected zones, stops and targets (1 Oct
  2026, Jan-Aug 2026, 5m): nearest TP1 -0.21R/trade (1,322 trades), nearest
  valid >= 1.8R -0.10R (14,944), >= 1R -0.10R (15,064). The valid-target rule
  halves the loss per trade; nothing is profitable on 5m. Numbers in
  [features/entry-setups.md](features/entry-setups.md).
- [x] **Per-method SL / TP, nearest-valid TP1 at 1R, TGT1-3 graded, live tape
  grading, `missed`, 1m chart-only, whole candles only, no fee term** (1 Oct
  2026) -- see [history/2026-10.md](history/2026-10.md).
- [ ] **Watch the 1R minimum against the log.** The owner set TGT1 >= 1R (no
  maximum) over TEST.md's 1.8. With 31% won on the replay, 1R needs over 50%
  to pay; read the live log after a month and bring the owner the win rate
  and average R per method at 1R before anything else changes.
- [ ] **Signals still confirm on candle close** (by design: a forming-candle
  signal repaints and its alert would be wrong). If the owner wants an early
  view, add a "forming" preview on the board -- never journaled or alerted.
- [ ] **Deploys from the working tree**: `btc-desk-api` / `web` were rebuilt
  as `ee67f33-dirty` on 1 Oct ~06:58 IST without a release step; migrations
  entry-008 to entry-013 run on the next start of whichever build carries
  them (008 deletes the 1m signal rows -- asked for). Agree a deploy rule with
  the owner.
- [ ] **Read the gate switches with the log**: a month of setups with every gate
  on is the record; anything logged with one off is counted apart
  (`gatesOff`). Before trusting a gate-off result, it needs its own month.
- [x] **R&D finding -- R:R was the gate that refused most** (May-Aug 2026
  replay): superseded on 1 Oct -- the fee term is gone, TP1 is the nearest
  target paying 1R, and every timeframe 3m-4H is logged.
- [ ] **R&D finding -- Liquidity sweep's stop is usually too wide**: 39% of its
  reads refused for a stop over 2.5 ATR (the sweep low to the MSS level). Decide
  with the owner whether its entry should be nearer the sweep; do not change it
  before the paper log has a month.
- [ ] **The replay cannot test methods 11 and 12, nor the with-timeframe 3m / 1m
  steps**: there is no recorded tape, option board or 1m history for 2024-26.
  Keep recording; re-run `scripts/entry-study.ts` once there is a quarter.

## Needs the owner

- [ ] **Deploy.** Nothing from 30 Sep is live: the desk runs `btc-desk-api:ed5f22d`
  (29 Sep), older even than the backstop stop (`4fc4551`). Deploy with nothing
  open ([guides/deploy.md](guides/deploy.md)), then run `deploy/refresh.sh` once
  so the desk gets the backfilled `chain.db` (756 days, to 29 Sep) and the
  reload goes through.
- [ ] **Two strategies on one contract: the targets are seen working live; the stop triggers are not.** The
  live record on 4 Oct 2026 (read, not tested): `P-BTC-84600-041026` held by 19 trades of 4 strategies at once,
  each with its own resting target; 432 overlapping pairs over 21 contracts in three days; 136 exits by a
  resting target. So Delta holds many reduce-only targets on one contract. What is still unverified is two
  *stop triggers* on one contract ([decision 0002](decisions/0002-simulator-is-not-the-venue.md)): none of
  the signal trades carries an option stop, so the live record cannot say. One strategy with an option stop,
  two trades on one strike, watched.
- [ ] **Signal trades carry no stop at Delta.** On 4 Oct 2026 all 22 open trades had a resting target and
  none an option stop: their stop is the signal's SL on the perp, watched by the desk, which acts only while
  the desk is up. The form says so; it is the owner's choice per strategy (Entry & exit -> option stop).
- [ ] **The else strike gathers the book on one strike.** With "at least OTM n, else OTM n" most signals go
  to the same strike: on 4 Oct 97 of 110 lots short were on `P-BTC-84600`. One move through that strike is
  one loss on all of them. A limit per strike, or an else strike that steps out as a strike fills, if wanted.
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
- [x] **Reconcile against Delta order history and direct client ID** (3 Oct
  2026): direct client ID endpoint first (`/v2/orders/client_order_id/{id}`),
  open book second, recent history third, and deep contract history by numeric
  `product_ids` with 30s rate throttle. Tested in `read-retry.test.ts`.
- [ ] **Execution controls not used yet**: `post_only`, `time_in_force: ioc`,
  `trail_amount`, bracket orders. Each needs a live test of its own. See
  [reference/delta-api.md](reference/delta-api.md).
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
