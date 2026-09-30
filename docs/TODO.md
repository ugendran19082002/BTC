# TODO

Open work only, most important first within each group. Each item says why it
matters and where the long form is. Finished work and the record of how things
broke is in [history/2026-09.md](history/2026-09.md); an item moves there
(ticked) when it is done.

Updated 30 Sep 2026 (evening): 25 items closed that afternoon -- see the history's
"30 Sep 2026 (afternoon)" entry.

---

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
