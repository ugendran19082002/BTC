# TODO

Status as of 2026-09-06. Ordered; the blockers at the top gate everything below.

## 0. Security — do first, nothing else depends on it

- [ ] **Revoke the Delta API key in `app-ket.txt` and issue a new one.**
      That key + secret pair was pasted into chat several times and is sitting
      in plaintext in the repo directory. Treat it as compromised.
      `app-ket.txt` is now in `.gitignore` and was never committed.
- [ ] Put the *new* key in `app/server/.env` (git-ignored) — never in source,
      never in a commit, never in a log line.
- [ ] Confirm no key is needed for market data. It is not: every endpoint this
      project reads is public.

## 1. Data

- [x] `harvest_chain.py` — 05:30 IST chain + 12:00 UTC settlement, one JSON per
      day, resumable, atomic writes.
- [x] Reject days where the feed throttled us instead of writing empty ones.
      (81 corrupted days were written and have been purged.)
- [ ] Finish harvesting 2024-09-04 → 2026-09-05 (~730 days) at low concurrency.
- [ ] Verify: every day has ≥15 legs, a settlement price, and strikes on both
      sides of the money.

## 2. The open reconciliation — still blocks any live sizing decision

- [ ] Get the **29-Mar-2025 AlgoTest trade log** (user action; only the account
      holder can pull it). Needed: PE strike / entry / exit, CE strike / entry /
      exit, day P&L.
- [ ] Compare against the rebuilt engine. AlgoTest reports March 2025 at +383;
      the reproduction shows a loss that day.
- [ ] Until this closes: do not raise lots, and do not call any variant final.

## 3. Backtest engine

- [x] Settlement-based exit (intrinsic at 12:00 UTC) — removes the exit-quote
      noise that broke the earlier reproduction.
- [x] AlgoTest "Premium Range" semantics: pick the *richest* strike inside the
      band.
- [x] Mark vs traded-price entry, with a staleness cutoff on traded prices.
- [ ] Rerun A / B / C / D' over the full period once harvesting completes.
- [ ] Per-year split (2024 / 2025 / 2026) for every variant — never judge on a
      single period.
- [ ] Saturday on/off comparison, to confirm the recommendation to sit out
      Saturdays.
- [ ] Hedged versions of each variant: max loss capped, cost of the hedge
      measured against the win rate it buys.

## 4. App

- [x] Fastify server: `/api/chain` (live + historical), `/api/backtest`,
      `/api/backtest/byyear`, `/api/sizing`, `/api/presets`.
- [x] Black-Scholes IV inversion + Greeks; agrees with Delta's own `mark_iv`.
- [x] Sell-side scoring, hedge pairing, bounded max loss.
- [ ] React + TypeScript front end: time selector (live / historical minute),
      chain table, sell candidates, bias panel, backtest tab.
- [ ] Show staleness on every traded price — a stale LTP is not a fill.

## 5. Prediction engine

See `PREDICTION-ENGINE-SPEC.md` for the full factor list.

- [ ] Direction model: UP / DOWN / RANGE probability over 12h.
- [ ] Structure model: given the direction probability, choose strike + hedge.
- [ ] Keep the two separate so each can be scored on its own.
- [ ] Walk-forward weight fitting; refit on periods the weights were not chosen
      on.

## 6. Deployment — `delta.thannigo.in` (204.168.233.179)

- [ ] Decide what actually gets exposed. The host currently answers HTTP 301.
- [ ] Need from the user: SSH access, and confirmation to touch that server.
- [ ] Reverse proxy + TLS, server as a systemd unit, static front end build.
- [ ] The server process must hold no trading key until the strategy question
      is settled. Read-only market data first.

## Standing constraints

- Real AlgoTest is the source of truth; the reproduction is a hypothesis.
- Do not use optimization results for live decisions while the mismatch is open.
- India entity only. All expiry times IST. 1 USD = 85 INR for P&L display.
- Never log in to or operate the user's AlgoTest account.
