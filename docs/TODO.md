# TODO

Live: https://delta.thannigo.in
Updated 8 Sep 2026

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

**2. Change the desk password.**
There is a login now — username `ugendran` — but the password you chose was
typed into chat, so treat it as public in the same way as the API key. Change
it with:

```bash
cd app/server && npx tsx hash-password.mjs
# paste the DESK_PASSWORD_HASH line it prints into app/server/.env
cd ../.. && ./deploy/deploy.sh
```

The password itself is never stored — only a scrypt hash of it, in `.env`,
which is git-ignored and not in any image. Sessions are a signed cookie that
lasts a day; eight wrong attempts locks that address out for ten minutes.

If you would rather it were not on the public internet at all, this machine
runs Tailscale: change the web port in `deploy/docker-compose.yml` from
`0.0.0.0` to your Tailscale address.

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

### Two ways to pick the strike

You choose one at the top of the page. Both were measured on the same 733 days.

| | most premium | safest |
|---|---|---|
| picks | furthest strike still paying your floor | richest strike clearing **both** your floor and your safety bar |
| profit factor | 3.08 | **9.67** |
| worst day | −$7.08 | **−$3.66** |
| return ÷ drawdown | 11.8 | **23.4** |
| days it trades | 653 | 456 |
| total | ₹8,250 | ₹7,268 |

Safest makes about 12% less money with three times the profit factor and half
the worst day.

**Two things about it that surprise people, both measured:**

1. **A higher safety bar does not get you more premium.** A strike that safe is
   a long way out, and strikes that far out are cheap. The bar buys a smaller
   worst day, not income.
2. **99% is worse than 98%.** It fails 2024 outright — profit factor 1.23 on 29
   days — because it waits for conditions that year rarely offered. 98% is the
   tightest bar that survived every year.

**One side alone is normal in safety mode.** When only one side clears both
bars, the whole position goes there. Skipping those days drops it from 456 days
to 215 and the return per unit of drawdown from 23.4 to 13.6. Most qualifying
days are one-sided.

(In "most premium" mode this never comes up: at a $15 or $20 floor both sides
always have something far enough out. Across 733 days there were no one-sided
days at all, and only three at $25.)

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
| **→ 0** (big number) | the maths, corrected by what really happened to 27,371 strikes like it |
| **ends out of the money** | the raw maths answer, N(d2), before that correction |
| **ever touches your strike** | might cross it at some point, even if it comes back the right side |
| **premium drops to near zero first** | the option price collapses before expiry — simulated, 2,000 paths |

Two things that are **not** part of this:

- **Delta is not a probability.** The desk used to treat it as one. Fixed.
- **Open interest and volume are not part of it either.** They tell you whether
  you can get filled and get out. They do not change the odds of the strike
  expiring worthless — only distance, volatility and time do that.

### Why every strike now shows a different number

The history is grouped into 5-point buckets, so reading a bucket rate straight
off gave every strike in the bucket the same percentage. A call and a put with
completely different open interest showed an identical number, which looked
broken — and it hid the difference between a strike at the edge of a bucket and
one in the middle.

The bucket now supplies a *correction* instead: how far reality sat from the
maths for strikes like this, blended between neighbouring buckets and added to
this strike's own number. So 78,000 reads 2.41% and 78,200 reads 4.16%, where
both used to read 13.56%.

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

### The chain shows every strike Delta has — which is fewer than you ask for

"Strikes each side" is set to 30, and the table comes back with about a dozen
each way. That is not a truncated fetch. Delta opens a daily contract over a
narrow band around the money and adds strikes only as BTC travels toward the
edge. On 9 Sep it listed 24 calls and 23 puts in total, 76,800 to 82,800, with
spot at 79,200 — so 30 each side gets you everything there is.

The table now says so in a line above it whenever the window came back short,
rather than silently showing less than the setting reads.

### Other things that are worked out, not typed in

- **The at-the-money strike** is calculated from live spot every refresh.
- **Strike spacing** is now read from the strikes Delta is actually listing,
  not assumed to be $200. Delta uses $200 near the money and $400 further out,
  and that is an observation about today, not a promise.
- **Lots per side** are worked out each refresh from the 24-hour move and the
  daily trend. The 70/30 figure is fixed — a version that scaled smoothly with
  signal strength was tested and was worse in 2024 and 2026.
- **The two sides always add up to your total.** They used to be able to sum to
  eight lots for a seven-lot decision.

### Layout, 8 Sep 2026

**How far it has moved** is no longer a card of its own — it is a section under
the contract card. It was repeating the expected move that card already gave,
and the two only mean anything read together: ±$650 priced against $1,772
travelled yesterday is the point, and it was split across the page.

**Where the money sits** was removed on request. Nothing is lost from the
decision: every figure on it — put/call ratios, open interest walls, gamma,
IV skew — was tried as a trading rule and none held up across 2024, 2025 and
2026, so none of them ever touched the recommendation. `/api/chain` still
returns the numbers if you want them back.

**Live** and **What to sell** now sit above the chain — the two things you read
first are the two things you see first, without scrolling past twenty strikes.
**Where the money sits** moved down beside the other reference cards.

The **How far it could move** card — the per-horizon table of what BTC did over
a year of windows — was removed on request. The measurement behind it stands
and `research/measure_horizons.py` still refreshes it; `/api/chain` still returns it.
Nothing else depended on it.

**How far it has moved** (the last 5m/15m/1h/24h, and the biggest day this
month) is a different card and is still there, in the reference row below the
chain. It was taken out by mistake for one deploy and put straight back.

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
- **Direction forecasting is closed, not pending.** It was measured, not
  assumed. Over 105,119 five-minute windows spanning a year, the chance BTC
  finishes higher never moves further than **0.6 points** from a coin flip at
  any horizon from 5 minutes to 12 hours. Filtering by trend, or by whether the
  last bar was up, changes it by under a point. A 14-day sample suggested 64%,
  which is exactly what noise looks like before you get more data.
  So the desk forecasts **distance, not direction**, and the "up" column stays
  on the page at ~50% to make the case against adding one later.

---

## HOW THE CODE IS KEPT HONEST

- **39 tests**, run automatically before every deploy. `npm test` in
  `app/server`. They cover the probability maths, the pricer, the split rule,
  lot allocation, strike-step detection and the summary statistics.
- They have already caught three real bugs: lots summing above the total, a
  negative zero in the statistics, and every strike in a bucket reading the same.
- Nothing goes into the recommendation unless it worked in 2024, 2025 **and**
  2026 separately. Everything else is shown as background and labelled as such.

## RULES I WORK BY

- AlgoTest is the truth. This project is a hypothesis until they agree.
- India only. All times IST. $1 = ₹85.
- I never log into your AlgoTest account.
- Nothing in this code can place an order. There is no code path for it.
- Nothing goes into the recommendation unless it worked in all three years.

## Use Delta's bracket endpoint for protection

`POST /v2/orders/bracket` attaches a stop and a target to an existing position
and runs the one-cancels-other *on the exchange*. That is strictly better than
what the desk does now, which is two independent reduce-only orders plus a poll
loop that cancels the loser.

It is not wired up yet, and deliberately so. The two-order path is covered by
cases 17, 18, 32 and 36, and the catastrophic outcome — both exits printing and
flipping a short into a long — is already prevented by reduce_only being
enforced at fill time. Swapping in an untested path on a live-money route to
gain a smaller improvement is the wrong trade.

To do it properly:
  - teach PaperExchange bracket semantics (its fill-time reduce_only check
    already gives OCO for free, so this is mostly bookkeeping);
  - decide how to track the orders Delta creates, since the bracket response
    returns them rather than accepting our client_order_id;
  - port cases 17, 18, 32 and 36 onto the new path before switching.

## Removed from the desk, kept in the API

Two cards were taken off the page because they answered questions the desk had
already answered elsewhere. Neither endpoint was removed, so both can come back
without a server change.

### The "Not yet" verdict card

`VerdictPanel`, fed by `verdict` on `/api/chain`. It listed the entry window,
the weekday record, whether both legs cleared the premium floor, the RSI band,
and whether a hedge was available.

Why it went: by the time you are looking at it, the recommendation card above
has already said what to sell and the ticket refuses what it should refuse. The
one line it carried that nothing else says is the hedge warning —

    CE and PE could not be hedged — no strike listed at that distance.
    The loss on that leg is bounded only by how far BTC travels.

which is a real thing to know and now has nowhere to appear. Before this is
called done, that belongs somewhere: most naturally on the ticket, beside the
close-out price, since it is the same question — what is the worst case, and is
it bounded.

`VerdictPanel.tsx` is still in the tree and still compiles; it is simply not
rendered.

### The premium-floor sweep

Already written up above.

## Watch the entry window

The verdict card was also the only thing that said "the window has not opened,
entry is 05:30–06:00 IST, 7.7h away". The desk now lets you sell at any hour.
That is correct — it is your account — but the 733-day record it quotes was
built entirely on 05:30 entries, so a trade taken at 21:49 is not the trade the
numbers describe. The ticket should say so when the window is closed, in one
line, without blocking anything.

## Execution controls the desk does not have yet

Measured against AlgoTest's leg configuration, which is the shape every options
desk converges on. What exists is listed so the gap is visible rather than
assumed.

| Control | Here |
|---|---|
| Entry order type: limit / market | yes — four buttons, two order types |
| Convert to market after N sec | yes |
| Exit order type: limit / market | fixed: target is a limit, stop is a market |
| Limit buffer (% off the reference price) | no |
| Trigger buffer | no |
| Target/stop reference: traded or LTP | fixed: the fill price, stop triggers on mark |
| Monitoring frequency | fixed at one second |
| Delay entry by N sec | no |
| Auto square-off on margin error | no |

The four price buttons are four ways of choosing a limit price, not four order
types — `entry-types.test.ts` pins that mapping. What actually separates them is
whether the order crosses the spread or rests on it.

### post_only

The most valuable single addition. `post_only: true` makes "rest at the offer"
a guarantee: the exchange refuses the order rather than let it take liquidity.
Right now resting is a hope — a price that has moved by the time the order lands
can be crossed into, and the spread is paid on a trade that meant to earn it.
It belongs on the ask button.

### time_in_force: ioc

Fill whatever is on the touch now and cancel the rest. A gentler market order
for a thin book, and this book is thin. Delta accepts it; nothing sends it.

### Stop entries and trailing stops

`stop_order_type` on an entry ("sell when it reaches X") and `trail_amount` are
both accepted by Delta and neither is offered. A stop here is only ever an exit.

## Close-out price on a position without a stop

A position with no stop exits at the exchange's close-out, and that price is on
the ticket before the trade but nowhere afterwards. The position row shows
"stop none", which is true and not useful: the row should name the price the
exchange will act at, because that is the real exit.

## Profit and loss

What is there now: the exchange's own mark, unrealised P&L, and how much of the
credit has decayed, on each position row, plus a running total on the Positions
tab. Delta's figures are used rather than a second calculation here, so the
desk and the exchange screen cannot disagree while somebody is checking both.

What is missing:

- **The day's realised total.** `store.realisedSince()` computes it and the
  daily-loss gate reads it, but nothing shows it. A desk that will stop you
  trading at a loss limit should say how close you are to it.
- **A record of closed trades.** `/api/trade/history` returns them and nothing
  renders it. Every trade this desk has ever placed is in the journal with its
  full event list; there is no screen for it.
- **P&L in rupees.** Every figure is in dollars. The account is Indian and the
  backtest reports both, so the position card should too.
- **Cost of getting out.** Unrealised P&L is marked at the mid. Closing pays the
  spread, and on an 11% book that is most of a small profit. The number that
  matters is what you would keep after closing, not what you are up on paper.

## Where the Live tab stops

The Live tab answers "should I sell, and what" and stops there. It does not
know a position exists. Once one does, the first question changes to "how is
the one I have doing", and that answer is one tab away. A line at the top of
Live — what is on, what it is worth — would close the loop without duplicating
the Positions tab.

## Polling, and where it should stop

Three clocks now, chosen by what each answers and what it costs:

| What | Every | Why |
|---|---|---|
| `/api/spot` | 1s | one number, cached 800ms at the server |
| `/api/trade/status` | 1s | mark and P&L on open positions, positions cached 800ms |
| `/api/chain` | 5s | the whole board, thirty strikes both sides |
| `/api/errors` | 30s | a count for the tab badge |

The caches mean the poll rate and the exchange call rate are not the same
number: ten open tabs are still one call a second. The engine deliberately does
not read those caches — protection and reconciliation ask the exchange directly,
because they decide whether contracts exist and must not act on a figure from a
moment ago.

Where this should go next is a websocket. Delta publishes one, and polling a
price a thousand times an hour to learn it changed twice is the wrong shape.
The reason it has not been done: the poll loop is what every one of the 199
server tests drives, and a socket is a second code path into the same state
machine. It should be added as a *source* that feeds the same `poll()` rather
than as a parallel way to mutate a trade.

## The Orders screen, and what it does not do yet

There is one now: four statuses, an IST date range defaulting to today at both
ends, and a CSV download that opens cleanly in Excel. The statuses come from the
server (`trading/status.ts`) so the list, the counts and the download cannot
disagree about what a trade was.

Missing:

- **Paging.** The range query caps at 1,000 rows and says nothing when it hits
  the cap. Fine for a desk placing a handful of trades a day; wrong the moment
  it is not.
- **A total on the range.** The screen lists trades and never adds them up. The
  first question about a week of orders is what the week made.
- **The exchange's own record.** This lists what *this desk* did. A trade placed
  from the Delta app is not in the journal and will never appear, which makes
  the screen quietly incomplete rather than wrong. `/v2/orders/history` would
  reconcile the two.

## Exits can be moved now

The stop and target were only ever chosen at entry -- the one moment you know
least about how a trade is going. `updateProtection` takes the resting levels
off the book before putting the new ones on, so there is never an instant with
two live, and an explicit change skips the retry backoff because it is not a
retry. Turning the stop off is a decision and does not raise the alarm.

Still to do: **a trailing stop**. Delta accepts `trail_amount`, and a stop that
follows the option down is the natural next thing once a position is in profit.
It is not offered.

## Refusals and where they are read

Three gates can refuse one order at once, and the reasons used to sit under a
summary long enough to push them off screen -- so the button was dead and the
reason was a scroll away, which is the same as saying nothing. They are stuck to
the bottom with the button now.

The remaining rough edge: the three messages are written independently and read
as a list rather than as an explanation. "Spread is 28.4%", "Needs $3.93, have
$0.18" and "worst case exceeds today's budget" have one cause between them --
the account is too small for this contract at this size -- and saying that once
would beat saying three true things.
