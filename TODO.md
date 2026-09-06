# TODO

Live: https://delta.thannigo.in
Updated 6 Sep 2026

---

## DO THIS FIRST

**1. Change your Delta API key.**
The key in `app/server/.env` is the same one from `app-ket.txt`. That file was
pasted into chat several times, so anyone who saw the chat has your key. It
works right now — the desk reads your balance with it. Go to Delta, delete that
key, make a new read-only one, paste the new one into `app/server/.env`, and
run `./deploy/deploy.sh`.

The setup around it is safe: the file is not in git, not in any Docker image,
and only loaded when the server starts. Only the key itself is the problem.

**2. Decide who can open the site.**
Right now anyone who types the address can see it, including your position
sizing. Two ways to close it:
- Put a password on it — uncomment two lines in `deploy/nginx.conf`, then run
  `sudo htpasswd -c /etc/nginx/.htpasswd-delta yourname`.
- Or make it private — this machine already runs Tailscale, so change the web
  port in `deploy/docker-compose.yml` to your Tailscale address.

**3. Get the 29-Mar-2025 trade log from AlgoTest.**
Only you can log in and download it. AlgoTest says that day made money, my
version says it lost money, and until we know why, every number in this project
is a *guess* about your real results, not a measurement of them.

---

## WHAT THE DESK DOES NOW

You open it, and it tells you one of three things: **Enter**, **Not yet**, or
**Stand aside** — with the reasons.

When it says Enter, it gives you the exact orders: which strike, which side,
how many lots, at what price.

### The rules it follows

Three rules. Each one was tested on 733 days and had to work in 2024, 2025
*and* 2026 separately before it was allowed in.

**Rule 1 — pick the strike.**
Take the furthest strike that still pays your minimum premium. Rank them by how
often strikes like that actually expired worthless, using 27,371 real
settlements — not by what the maths model claims.

**Rule 2 — split the lots.**
Normally half calls, half puts. But if BTC moved more than 2% in 24 hours *and*
the daily trend agrees, put 70% on the side that keeps paying if the move
carries on.
Result: profit factor 1.93 → 2.38. Worst day −$8.97 → −$7.08.

**Rule 3 — skip bad days.**
If daily RSI is above 70 or below 30, don't trade.
Result: profit factor 1.93 → 2.59. Costs about one day in nine.

**All three together:** ₹7,319 → ₹8,250, and it trades 80 *fewer* days.
Profit factor 1.93 → 3.08. Biggest drawdown $12.22 → $8.24.

### Three different "chance of going to zero"

These are three different questions and the desk keeps them apart:

| Shown as | Means |
|---|---|
| **expired at zero, historically** | out of 733 real settlements, how many strikes like this one ended worthless |
| **lands out of the money** | the maths answer, N(d2) |
| **touches the strike** | might cross it at some point, even if it comes back |
| **premium collapses first** | the option price drops to near nothing before expiry — simulated |

Note: **delta is not a probability.** The desk used to treat it as one. That was
wrong and is now fixed.

---

## WHAT WAS TESTED AND THROWN OUT

Do not put these back without new evidence. Each looked promising and failed.

| Idea | What happened |
|---|---|
| Stop loss | Cut profit by more than half at every level. ₹14,638 → ₹4,201. It cuts winners. |
| Skip low-volume days | ₹7,319 → ₹3,836 |
| OI acceleration | Great on its own, useless combined. 2026 fell from 6.53 to 2.49 |
| Lean toward the "safer" side | 2.10, worse than the momentum rule |
| Lean toward the riskier side | 1.80, worse than doing nothing |
| MACD alone | 1.96 against a 1.93 baseline. Noise. |
| Skip when the market underprices risk | Looked brilliant in 2026, collapsed to 1.06 in 2024. Classic overfit. |
| ATR filters | Less profit, no less risk |

---

## THINGS WORTH DOING NEXT

- **Exit rule.** Closing when the option has lost 95% of its value beat holding
  to expiry — ₹15,225 vs ₹14,638 — and the target was hit on 97.5% of days,
  usually about 8 hours in. The desk only handles entries so far.
- **Weekend.** Monday to Friday lost on 3 days out of 461, worst −$0.95.
  Saturday and Sunday lost on 7 out of 209, worst −$8.48, and hold all six of
  the biggest losses in two years. The desk warns you; it does not stop you.
- **Hedging is mostly not available.** At the distance this strategy sells,
  Delta lists nothing further out to buy on about 3 days in 4. Where it does,
  the hedge often costs almost as much as the premium. That is why the tested
  version is naked and controls risk with position size instead.
- **12-hour direction forecast.** Still just a written plan in
  `PREDICTION-ENGINE-SPEC.md`. What exists today is a market read, clearly
  labelled as background information, not a signal.

---

## RULES I WORK BY

- AlgoTest is the truth. This project is a hypothesis until they agree.
- India only. All times IST. $1 = ₹85.
- I never log into your AlgoTest account.
- Nothing in this code can place an order. There is no code path for it.
- Nothing goes into the recommendation unless it worked in all three years.
