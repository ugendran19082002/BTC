# TODO

State as of 2026-09-06. Live at https://delta.thannigo.in

## 0. Security — still open, still first

- [ ] **Revoke the Delta API key and issue a new read-only one.**
      The key now in `app/server/.env` is the one from `app-ket.txt`, which was
      pasted into chat more than once. It works — the account endpoint returns
      real balances with it — which is exactly the problem. Anyone who has seen
      this conversation holds it.
      The wiring is right: `.env` is git-ignored, is not in any image, and is
      injected at runtime. Only the value needs replacing.
- [ ] Decide who can reach the desk. It is on the open internet and shows
      sizing, and positions once the account panel is on. Either uncomment the
      `auth_basic` lines in `deploy/nginx.conf`, or bind the web container to
      the host's Tailscale address instead of `0.0.0.0`.

## 1. Data — done

- [x] 733 expiry days, 2024-09-04 to 2026-09-06, no gaps. Quality checks clean:
      no negative marks, no call priced below intrinsic, strikes on both sides
      of the money every day.
- [x] Intraday mark paths for the traded legs (1,466), so exits can be tested.
- [x] Open interest for the traded legs (1,449).
- [x] Calibration: 27,371 legs bucketed by model probability against what
      actually happened.
- [x] `deploy/refresh.sh` on cron at 12:40 UTC keeps it current.

## 2. What is in the live engine, and why

Three rules. Each improved 2024, 2025 and 2026 taken separately, which is the
only reason it is there.

| | rule | effect on the full period |
|---|---|---|
| 1 | sell both sides, furthest strike still bid at the floor | baseline, PF 1.93 |
| 2 | 70/30 split when the 24h move and daily trend agree, else 50/50 | PF 2.38, worst day −$8.97 → −$7.08 |
| 3 | stand aside when daily RSI(14) is outside 30–70 | PF 3.08, drawdown $12.22 → $8.24 |

Together: ₹7,319 → ₹8,250 on 80 fewer days, R/MDD 7.04 → 11.78.

## 3. Tested and rejected — do not re-add without new evidence

- **Stop losses.** Every level cut the total by more than half (₹14,638 → ₹4,201
  at 2× credit). They cut winners.
- **Option volume as a filter.** Skipping thin-volume days: ₹7,319 → ₹3,836.
- **OI acceleration.** Looked strong alone (PF 3.10) and failed once stacked:
  PF 3.08 → 2.81, and 2026 collapsed from 6.53 to 2.49 on 70 remaining days.
- **Leaning toward the model's "safer" side.** PF 2.10, below the momentum rule.
- **Leaning toward the riskier side.** PF 1.80, worse than doing nothing.
- **MACD alone.** PF 1.96 against a 1.93 baseline. Noise.
- **ATR filters, |24h| > 4% filter.** Both reduced return without improving
  risk.

## 4. Open

- [ ] **29-Mar-2025 AlgoTest trade log.** Only the account holder can pull it.
      Until the reproduction and AlgoTest agree on one day, none of the above is
      a measurement of your live results — it is a hypothesis about them.
- [ ] Booking at 95% decay beat holding by a little (₹15,225 vs ₹14,638, PF 2.09
      vs 1.93) and the target was hit on 97.5% of days, median 8.1 hours in. Not
      wired into the desk yet; it needs an exit rule, not just an entry one.
- [ ] Weekend. Monday–Friday lost on 3 days of 461, worst −$0.95; Saturday and
      Sunday lost on 7 of 209, worst −$8.48, and hold all six of the largest
      losses in two years. The desk warns; it does not refuse.
- [ ] The 12-hour direction model in `PREDICTION-ENGINE-SPEC.md` is still a
      spec. What exists is a market read, clearly marked as context.

## 5. Standing constraints

- Real AlgoTest is the source of truth; this reproduction is a hypothesis.
- India entity only. All times IST. 1 USD = 85 INR.
- Never log in to or operate the AlgoTest account.
- No order placement anywhere in this codebase.
