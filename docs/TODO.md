# TODO

Open work only, most important first within each group. Each item says why it
matters and where the long form is. Finished work and the record of how things
broke is in [history/2026-09.md](history/2026-09.md); an item moves there
(ticked) when it is done.

Updated 30 Sep 2026. Rebuilt that day from the 198 unticked items in the old
TODO: items about features since removed (the Signals tab, the analytics
service, the market-state journals, the old Live cards) and "deploy this"
items long since deployed were dropped; the history still has them.

---

## Needs the owner

- [ ] **Two strategies on the same contract.** `5-01-copy` (15:55) and `5-01`
  (17:01) chose the same strikes on 26, 27 and 29 Sep and the second was
  refused `DUPLICATE_POSITION`. The gate is right for today's engine, which
  holds one trade per contract. Allowing it is an engine change with a live
  one-lot test -- see [decision 0011](decisions/0011-one-trade-per-contract.md)
  for the design. Go-ahead needed.
- [ ] **The $5 premium floor at 17:01.** 29 minutes before settlement most legs
  pay under $5 (28 Sep CE 3.02, 27 Sep PE 3.89, 26 Sep PE 0.57); AlgoTest took
  them, the gate refused them. Option: a per-strategy `minPremiumUsd`
  (default: the desk floor), passed to the precheck the way an add already
  overrides it. A money gate, so the owner's call.
- [ ] **The desk's dataset stopped on 8 Sep.** `refresh.sh` runs daily and logs
  `wrote 1`, but the harvester writes to `harvester/chain.db` (its default
  when `CHAIN_DB` is unset -- 22 days there, 8-29 Sep) while the script ships
  the repo-root `chain.db`, still 735 days ending 2026-09-08. Then
  `POST /api/reload` answers **401**: it has been behind the sign-in gate
  since 11 Sep. Fix: `export CHAIN_DB="$ROOT/chain.db"` in `refresh.sh`,
  backfill with `CHAIN_DB=$PWD/chain.db python3 harvester/harvest_chain.py
  2026-09-08 <today>`, and reload without a session (a `docker exec` into the
  API, or `config.auth: 'public'` limited to the docker network). The cron
  also fires at 12:40 IST (`CRON_TZ=Asia/Kolkata`), before the 17:30
  settlement -- 18:10 IST is what `40 12` UTC meant.
- [ ] **Rotate the credentials pasted in chat** (Delta API key, desk password,
  Telegram token -- [security audit](history/2026-09-11-security-audit.md) #14),
  and confirm `DESK_SESSION_SECRET` is 32 random bytes (#15). Only you can.
- [ ] **Auto-trade and best-trade have no screen.** `AutoTradeSettings.tsx` and
  `BestTradeSettings.tsx` are unmounted; the server still runs both from their
  saved settings. Mount them on Settings or retire them.
- [ ] **Review the trend plan's paper log** on 31 Oct 2026, then monthly: live
  1H / 4H trades, net R after fees, the two pre-registered filters. Drop the
  plan if it is negative after ~40 live trades.

## Trading engine and strategies

- [ ] **Five server tests fail at HEAD** (seen 30 Sep; likely `4fc4551`, the
  offer-confirmed stop): `e2e/strategy-lifecycle` 7, 9, 11, 12 and
  `strategy/exit-steps` "real time: a strategy trade on the paper exchange".
- [ ] **A 99% target can round to zero.** An entry of 1.0 x 0.01 is a target of
  0, which is not an order. Floor targets at one tick. Matters as soon as a
  cheap leg clears the floor.
- [ ] **Delta's stop direction is still unverified** live. One deliberate
  one-lot test. The take-profit was "conventional" too, until 9 Sep.
- [ ] **One live test of a stepped exit** with one lot: a stage moving a real
  Delta target / stop in place.
- [ ] **The exit-stage memory is in-process**: after a restart the stage in
  force is applied once more.
- [ ] **A market exit that fills in part is left there.** "Close now" and the
  stop watch do not follow up the remainder.
- [ ] **"If closed now" is priced at the mark**; a buy-back pays the ask.
- [ ] **Execution controls not used yet**: `post_only`, `time_in_force: ioc`,
  `trail_amount`, bracket orders; and reconciling against
  `/v2/orders/history` as well as the open book. See
  [reference/delta-api.md](reference/delta-api.md).
- [ ] **The two premium floors differ**: 5 in the trading gate, 15 as the chain
  default.
- [ ] **An entry between 17:30 and 17:35 IST lands in Delta's launch auction.**
  The strategy form allows it.
- [ ] **Measure scheduled entries**: record the spread and the wait at each
  scheduled fill, so `maxCrossSpreadPct` is a measured number.

## Market data and the database

- [ ] **Five schemas migrate lazily**, on first write: `bookHeatSchema`,
  `indexSchema`, `annotationsSchema`, `trendPaperSchema`,
  `chainFeaturesSchema` are not called at boot, though `index.ts` says every
  ledger entry is applied before `listen`. A deploy can report healthy with
  those tables missing. Call them at boot.
- [ ] **Delta's public socket is moving** to `public-socket.india.delta.exchange`;
  the desk uses `socket.india.delta.exchange` (answered on 29 Sep). Verify
  before it is switched off.
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
- [ ] Dead web helpers from the removed panels, found by knip: `horizonRows`,
  `mtfConsensus`, `sideCards`, `tierOfTf`, `TradeFlowPanel`,
  `OptionFlowPanel`, `WindowSelect`, `Sparkline` and others.

## Security and operations

- [ ] **`/api/health` answers without a session** with the migration list, row
  counts and feed detail. Keep the probe; cut the unauthenticated body to
  `{"ok":true}` (audit #13).
- [ ] HSTS `includeSubDomains` / `preload`, once every `thannigo.in` subdomain is
  HTTPS (audit #16).
- [ ] A Delta trade-history CSV with order ids was committed in `34383e4`
  (removed since, still in history). Decide whether history needs rewriting.
- [ ] Remote deploys (`--host`) do not prune old images on the remote host.

## Code hygiene and docs

- [ ] **119 files have no header comment** and **32 routes no comment** -- the
  dashes in [reference/files.md](reference/files.md) and
  [reference/api.md](reference/api.md). Write them; the pages regenerate.
- [ ] Unused parameters `tsc --noUnusedParameters` finds (`market-state.ts`,
  `score.ts`, `option-snapshots.ts`, `select.ts`); 98 exports used only in
  their own file.
- [ ] The web suite's 5 s per-test timeout is tight on a 4-vCPU box that also
  runs the desk.
- [ ] `analytics/` holds only git-ignored caches; delete it locally.
