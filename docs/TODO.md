# TODO

Live: https://delta.thannigo.in
Updated 12 Sep 2026

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

**4. Revoke the Telegram bot token.**
The token in `app/server/.env` (`TG_TOKEN`) was pasted into chat, so treat it
as public like the key above: anyone holding it can post as your bot. In
Telegram, open @BotFather, send `/revoke`, pick the bot, put the new token in
`app/server/.env`, and run `./deploy/deploy.sh`. The chat id is not a secret.

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

## Telegram alerts — 10 Sep 2026

**What it does.** With `TG_TOKEN` and `TG_CHAT_ID` set in `app/server/.env`,
the desk sends a Telegram message when:

- **an entry fills** — the contract, how many filled out of how many asked, the
  average price, the premium in ₹ and $, and the target and stop (or a warning
  that there is no stop);
- **an exit fills** — target hit, stop-loss hit, or closed at market, with the
  P&L booked and whether the position is flat yet;
- **a position turns up closed on Delta** with no exit fill from the desk — a
  stop that fired while the desk was down;
- **the last open position closes** — one summary for the day, with the date:
  trades, how many won and lost, premium collected, gross P&L, charges, net
  P&L, how much of the premium was kept, and one line per trade.

A fill that arrives in pieces is held for four seconds and sent as one message.
A paper fill says PAPER on its first line. Orders that did not fill send
nothing. If Telegram is down the desk keeps trading; the failure goes to the
error log, never to the order path.

**To do:**

- [ ] **Revoke the bot token and set a new one.** See item 4 at the top.
- [ ] **Deploy it.** The running desk does not have this code yet. Run
      `./deploy/deploy.sh` when nothing is open, then check the api log says
      `telegram fill alerts on`.
- [ ] **Watch one live day end to end.** The morning entry, the evening exits
      and the day summary should each arrive once, in that order. The tests
      prove the arithmetic; only a live day proves the timing.
- [x] **Charges include GST.** `trading/charges.ts` is `min(0.01% × notional,
      3.5% × premium) × 1.18`, checked against the account's own trade-history
      export: all 72 fills on 10 Sep match Delta's "Fees paid" to the last digit.
- [ ] **Read the exact fee per fill from Delta.** The formula matches, but the
      account's fee rate is 0.009% on the statement against 0.01% in the docs.
      It never matters while the 3.5% cap is the smaller half — true of every
      fill so far — but `/v2/fills` carries the real commission and would end
      the question.
- [ ] **Settlement at expiry.** A position held into the 17:30 settlement closes
      without a fill, so its P&L shows as unknown. Read the settlement price and
      count it.
- [ ] **Alert on `POSITION UNPROTECTED`.** That alarm still only reaches the
      screen, and it is the one that most needs to reach a phone.
- [ ] **Keep the mode on each trade.** The summary labels the whole day with
      the mode at the moment it is sent. A day that switched between paper and
      live would be labelled by whichever came last.
- [ ] **Daily summary when nothing traded.** No trades means no message, so a
      silent phone cannot tell "stood aside" from "the desk was down". A short
      message at the end of each day would settle that.

---

## Scheduled entries wait for a tight spread — 10 Sep 2026

**Before:** "sell at offer, market after 5s" rested at the offer and, after 5
seconds, sold at the bid whatever the spread — on a 37 / 44 book that sold at 37
and gave three and a half points away.

**Now (option B):** the order still rests at the offer at once. The walk toward
the bid continues only while the spread is at most the strategy's limit (15% by
default). While it is wider, the order waits at the mid. When the spread
narrows, it sells at the bid. If it is still unfilled when the 60-minute entry
window closes, what is left is cancelled and Telegram says ℹ️ NOT FILLED.
Orders placed by hand from the ticket are unchanged.

**To do:**

- [ ] **Measure it.** Record the spread and the wait at each scheduled fill, and
      compare against the old "bid after 5s" fills.
- [ ] **"Sell now" strategies** still refuse outright on a wide spread (the gate)
      and spend the day. They could wait the same way.

---

## Important alerts and a 60-minute entry window — 10 Sep 2026

**Grace time is 60 minutes** (was 30). An entry at 05:29 can still go on until
06:29:59 if the desk was restarting or Delta's feed was slow. Later than that
is still refused.

**Telegram now also sends the problems somebody has to act on:**

- 🚨 **Order rejected** by Delta, with Delta's reason.
- ⚠️ **Order status unknown** — Delta did not answer; the desk checks the
  account before sending anything again.
- 🚨 **Exit failed** — a close did not go through; says how much is still open.
- 🚨 **No stop-loss** — a stop was asked for and could not be placed. Once per
  alarm, not once per retry.
- 🚨 **Auto-trade failed** — the scheduler could place no leg, with each reason.
- ⚠️ **Auto-trade partly placed** — one leg on, one refused.
- ℹ️ **Stood aside today** — the rules said no; the reason is included, so a
  quiet phone is never a mystery.
- 🚨 **Entry missed** — the window closed and nothing was tried at all.

A gate refusing an order you placed by hand is not sent: the screen already
told you.

**Still to decide:** a refusal at the first check still spends the day (the
runner's comment says it retries; the code does not). Retrying until the window
closes means more trading days, but later entries than the ones tested.

---

## A target must never cross the spread — 10 Sep 2026

**What happened.** Both strategy legs today — sold at 15 and 12, target 1.00 —
were bought back at **2.00**. The mark reached 1.00 while the offer sat at
2.00; the desk's own watch cancelled the resting buy at 1.00 and sent a market
buy, which paid the offer. $0.425 a leg above the target, $0.85 (≈ ₹72) in all.
Earlier the same day it did the same to two hand-placed trades: a 24 short
exited at 21 against a 19.70 target, and a 32 short at 32 against 28.20 — the
whole profit.

**Fixed.** The watch now judges only the stop (on the mark, at the market,
because a stop has to get out). The target is only the resting reduce-only limit
buy: it fills when the offer comes down to it, at the target or better, and is
never cancelled for a market buy. Cases 75, 75b, 75c and 80b pin it.

**Trade-off, said out loud.** If the offer never comes down to the target, the
position stays on until expiry or until you close it. For an option that
expires worthless that costs nothing — no settlement fee — but it does mean
holding through the afternoon.

**Rolling it out without breaking what works:**

1. Nothing else changes: entries, the stop-loss (exchange trigger + desk
   watch, both at market), protection sizing and the strategy runner are as they
   were on the day that worked. Only the target's market buy is gone.
2. Deploy **with nothing open** — `./deploy/deploy.sh` rolls back on a failed
   health check, and the rollback now actually works.
3. Run **one day in paper** with the strategy, then switch back to live.
4. On the first live day, check on Delta that the target sits as a limit buy at
   its price, and that Orders says "target hit" when it fills.
5. If it has to be undone: `TAG=<previous tag> docker compose -f
   deploy/docker-compose.yml up -d` — the previous image is always kept.

**To do:**

- [ ] **Deploy** this — the live desk still has the old watch.
- [ ] **Stop-watch exits are still recorded as "manual".** A stop reached by the
      desk's own watch closes through `closeNowInner`, so Orders says "closed
      manually" and Telegram "closed at market". Record them as the stop.
- [ ] **A stop exit is still a market buy.** Use a limit a few ticks above the ask
      and retry, so a thin book cannot fill it far above the offer (Delta's own
      cap on today's market buys was 157.4 against a 2.00 fill).
- [ ] **Show the offer beside the target on Positions**, so it is visible how far
      the offer — not the mark — still has to fall.

---

## Phone screens, charges, speed and deploys — 10 Sep 2026

**Done:**

- **Today's P&L in the header**, always visible: booked + open − Delta charges
  since 05:30 IST. Tap it for the breakdown.
- **Charges everywhere money is shown.** Positions ("If closed now", charges
  paid and to close), Orders (net P&L after charges, gross and charges beside
  it, CSV columns), Account ("Charges today", "Net today"), the order ticket
  ("Delta charges to open") and the Telegram day summary. One formula,
  `trading/charges.ts`, matching the Delta statement to the last digit.
- **Simple English** on every screen, a bottom tab bar with icons, 44px-ish tap
  targets, and 16px form fields so iPhones do not zoom in on every tap.
- **Speed.** Positions, Orders, Strategy, Errors and the order ticket load on
  first open; libraries are split into cached chunks; source maps are no longer
  served. Polling stops while the page is hidden. Delta reads get an 8s timeout
  and one retry. SQLite waits for a lock instead of failing. Container limits
  raised for a server that runs only this desk.
- **Error log causes.** A phone going to sleep, losing signal, or a reply cut
  off mid-way no longer counts as a server error unless it keeps happening. The
  log now says in one sentence what each known error means.
- **deploy.sh.** Rollback fixed — it had never worked (wrong container name, a
  label that did not exist). `latest` now follows each build; uncommitted code
  gets a `-dirty` tag. After a healthy deploy it removes old btc-desk image tags
  (keeping the running one, the previous one and the newest 3), dangling
  layers, and build cache older than 3 days. `--no-prune` skips that. It never
  runs `docker image prune -a`, which would delete the rollback image and every
  other project's images.

**To do:**

- [ ] **Deploy.** The desk is LIVE; deploy with nothing open, then check the
      header P&L, a position's charges line, and the api log.
- [ ] **Mark the 6 old error rows read** after deploying. Their causes are fixed;
      the rows are history.
- [ ] **Old images.** 88 tags each of btc-desk-api and btc-desk-web (~14 GB with
      build cache) are removed by the first deploy's cleanup. The banknifty and
      house images (~3 GB) are not touched — remove them by hand if those
      stacks are gone for good.
- [ ] **Remote deploys** (`--host`) do not prune on the remote host.
- [ ] **The order ticket is still long on a phone.** Fold leverage and the exit
      bars under "More options" once the defaults are trusted.
- [ ] **The chain on a phone** still scrolls sideways. A card for the two strikes
      the desk would sell, above the full table, would answer most visits.
- [ ] **Strategy status text** comes from the server in developer wording
      ("too late -- 05:30 passed more than 60 minutes ago").
- [ ] **The Delta trade-history CSV is committed** (`34383e4`). It holds order ids
      and fills, not keys — but take it out of git before the repo is shared.

---

## Delta errors from the night of 10 Sep — 11 Sep 2026

**Done (not deployed yet):**

- **"Delta refused the request (http_200)" on `GET /v2/products/`** was not a
  refusal. With nothing open, the status poll asked for the product called `''`
  — which is Delta's whole product list, 3.7 MB and 1,136 products — and cached
  it as a product with no name. At 22:30, just after a restart, that download
  arrived unreadable. The poll no longer looks up a product at all (each trade
  carries its own contract value), `getProduct('')` returns nothing without a
  call, and a reply that is not one product is never cached.
- **A 200 whose body will not parse is its own error, `UnreadableReply`.** A read
  asks again once; after that, and for any write, it means "unknown", like a
  timeout.
- **Delta's own server errors (5xx) are an outage, never an answer.** A 500 used
  to count as a refusal: a cancel took it as "already gone", an order lookup as
  "no such order", and placing an order as "rejected" — each the dangerous way
  round. Now a cancel or a lookup throws, and a 500 while placing an order is
  "unknown", so the engine reads the account back instead of assuming nothing
  was placed.
- **The Errors screen** says what `http_200` / `UnreadableReply` and Delta 5xx
  rows mean, instead of "the message says which field it did not accept".
- Also waiting for the same deploy: "What to sell" figures (Delta's real margin,
  charges, the both-worthless chance), open trades on the Orders screen showing
  "if closed now" instead of their charges in red, Delta 5xx reads retried once,
  and browser connection drops logged only after a full minute.

**To do:**

- [ ] **Deploy** with nothing open, then check an open trade's Orders row, the
      "What to sell" margin line, and the api log.
- [ ] **Mark the `http_200`, `internal_server_error` and `Failed to fetch` rows
      read** after deploying. Their causes are fixed; the rows are history.
- [ ] **Inside the engine a failed lookup still reads as "not there".** Every
      `getOrderByClientId(...).catch(() => null)` in `engine.ts` turns an outage
      into "no such order", and three places act on it:
      - `cancelAndVerify` returns "gone", so `protect()` can place a replacement
        while the old order still rests — two exits for one position;
      - `cancelEntryInner` records the entry as cancelled without cancelling it;
      - `reconcileInner` can mark an `entry_unknown` trade "never reached the
        exchange" while its order is resting.
      Tell "could not ask" apart from "asked, and nothing is there" (for example
      `undefined` against `null`), and in each case try again on the next poll
      instead of concluding. It is an engine change: add the cases to the server
      suite first.
- [ ] **"If closed now" is priced at the mark.** Buying back pays the ask, which
      on a wide book is well above the mark, so the figure can look better than a
      real close would be. Price it at the ask, or show both.
- [ ] **A strike with a 100% history adds no expected loss** in "What to sell"
      (the 74,000 PE on 10 Sep). Floor the chance of losing by the sample size —
      roughly 3 ÷ sample when no loss was ever seen.
- [ ] **The stop exit is a plain market order.** On a thin book a limit a few
      ticks above the ask fills almost as surely and cannot print at a silly price.
- [ ] **"Lots" means two things.** On the Live screen it is the total, split
      between CE and PE; in a strategy it is per leg. Rename one of them.
- [ ] **Rotate the Delta API key and the desk password**, which were exposed
      earlier, at the same time as revoking the Telegram token (item 4 at the top).
- [ ] **Server housekeeping:** two certbot renewal timers are installed (keep one),
      and the old tailscale certificate files are still on disk.

---

## A target that fills in pieces — 11 Sep 2026

At 09:08 IST the 74,000 PE (425 sold at 12.00, target 0.70, no stop) bought back
200 at the target, and 3 more at 09:09. 222 stayed short with the target still
resting. Telegram sent two "TARGET HIT" messages and the Orders row showed
neither piece.

**What was wrong:**

- **The engine treated the first piece as the whole exit.** It named the target
  the winner, cancelled the stop as its "sibling", and put the trade in
  `exit_pending`, where the desk neither re-protects nor watches the stop. This
  trade had no stop, so nothing was lost. With a stop, the 222 left would have
  had none, and nothing would have said so.
- **Telegram's second message was the total, not 3 more.** "Bought back 203"
  under "TARGET HIT" read like 403 bought back.
- **Positions said "Sold 222 @ 12.00"** for a trade that sold 425, and the Orders
  row said only "short 222".

**Done (not deployed yet):**

- A target or stop that fills in part leaves the trade as it was. The other
  leg stays on the book, resized to what is still short, and the desk keeps
  watching the stop. Only the exit that makes the position flat is the winner.
  A market exit in pieces is still `exit_pending`, as before.
- **The target itself is unchanged:** a resting reduce-only limit that fills
  when the ask comes down to it, at its own price. A half-filled target is kept
  as it is. It is never edited, because Delta's edit `size` is the order's total
  including the filled part, so asking a half-filled 425 for 222 could leave 19
  resting. If it no longer matches the position (a hand close), it is cancelled
  and placed again for the right size.
- Protection bigger than the position now counts as the wrong size, so the stop
  is trimmed to what is left.
- Telegram: "🎯 TARGET PART-FILLED · Bought back 203 of 425 · Booked so far ·
  Still short 222 — target resting at 0.70". "TARGET HIT" only when flat.
- Positions: "Sold 425 @ 12.00 · 203 bought back @ 0.70 · 222 left", with
  "Open P&L" beside "Booked".
- Orders: still one row per trade. It now shows "sold 425, bought back 203 at
  0.70, short 222", "Bought back so far" and "Booked so far" in the detail, and a
  list of every fill.
- Tests: `test/trading/partial-target.test.ts` covers the stop staying, the
  target resting unedited, the stop watch still firing, and fills only at the
  target price once the ask reaches it. Telegram, status, Positions and Orders
  tests cover the rest.

**To do:**

- [ ] **Deploy with nothing open.** A trade already in `exit_pending` from a
      partial target before the deploy stays there. Only new fills get the new
      handling.
- [ ] **A market exit that fills in part is left there.** "Close now" and the
      stop watch cancel both legs and then send a market order. If that order
      fills only part, the trade sits in `exit_pending` with nothing resting:
      Delta does not rest a market order, and the poll never looks the exit
      order up again. Re-send for what is left, or put the stop back, on the
      next poll. It is an engine change: tests first.
- [ ] **Check Delta's edit `size` meaning on one small live order.** The engine
      no longer edits a part-filled order, so either reading is safe today. The
      comment in `protect()` should state what Delta actually does.
- [ ] **The stop watch now acts on a stop that fired only in part.** Test 16:
      40 filled by the exchange stop, then the desk closes the rest at market
      while the mark is above the stop. That is what the stop watch is for, but
      it is new behaviour for a partial stop: watch the first real one.

---

## Add to the other leg when a target fills — 11 Sep 2026

Asked for: when the CE target buys back 425 (or however many), and the PE still
pays $3 or more, sell that many more PE. The same the other way round. Not when
the PE has doubled from its sale, and not on a one-sided (doubled) day. The $3
must be settable on screen.

**How it works (not deployed yet):**

- A new strategy setting, "Add to the other leg", is off on every existing
  strategy. When on, the minimum bid ($3) and the "not once it has risen to"
  multiple (2×) are set in the form. The form reads both back in the sentence
  and on example prices as they are typed.
- The contracts are **appended to the other leg's own trade**, not sold as a
  second trade. Delta nets one contract into one position, so two trades on the
  same contract would each read the other's contracts as their own, and cancel
  each other's target. One trade keeps one position and a blended average, with
  its **same target price and stop**, resized to the new size.
- The sell uses the strategy's entry logic: rest at the offer, then walk to the
  bid while the spread is within its limit, otherwise wait at the mid. It is
  **never sold below the minimum**, even if the bid falls while it walks. After
  5 minutes, whatever has not filled is cancelled.
- Guards:
  - only a target fill from the last 2 minutes;
  - not after the strategy's "latest time to add" (set on screen, between entry
    and exit; half an hour before exit by default);
  - the other leg must still be open (not closed, not closing);
  - one add at a time, and none while that leg's entry is still working;
  - a leg that was itself added to never adds back;
  - "doubled" is measured against the leg's first sale price.
- Every gate still applies (short limit, margin, spread, depth, feed, daily
  loss), except that holding the contract is allowed, and the desk's $5 premium
  floor gives way to the add's own minimum.
- Close now, the stop watch and the exit time all take a working add off the
  book first, so nothing sells after a close.
- Each decision is written to a new `strategy_adds` table **before** any order
  is sent, skips included, each with its reason. The nudge on a target fill and
  the 20-second tick both look, but the same contracts are only ever decided
  once, across restarts too.
- Telegram:
  - "➕ ADDED · Sold 425 more @ 7.0 · Because the CE target bought back 425 ·
    Now short 850 @ 11.0 avg";
  - "ℹ️ NOT ADDED" with the reason;
  - "⚠️ ADD REFUSED" or "🚨 ADD FAILED".
- Screens:
  - the Strategy screen lists every add decision;
  - Positions shows "Sold 850 @ 11.00 avg · 425 added", or "Adding 425 @ 7.50
    (never below 3.00)" while an add works;
  - Orders shows "850 (425 at entry + 425 added)", with "Added" rows in the fill
    log.
- Tests:
  - `test/strategy/add.test.ts` (25) covers the rules;
  - `test/trading/add-to-position.test.ts` (16) covers the engine;
  - `test/strategy/adder.test.ts` (11) runs end to end on paper;
  - store (+6) and message (+5) tests;
  - web form, panel, positions and orders tests.
- A live-price paper run passed 6 of 6: real Delta India quotes, paper orders,
  with each skip checked for the right reason.

**To do:**

- [ ] **Deploy with nothing open**, then turn the setting on in one strategy.
      It is off everywhere until someone does.
- [ ] **One 1-lot live add, with the user watching, before 425.** The paper
      exchange fills a resting sell in full once the bid reaches it. Delta fills
      only what the bid size allows, and the add's 5-minute window is what ends a
      thin fill. Check the fill, the resized target and stop, and the Telegram
      message against Delta's own screen.
- [ ] **On a wide book the add waits at the mid and may not fill.** In the first
      live run the PE was 11 bid / 13 offered (16.7% spread). The add stopped at
      12 and was still resting 45 seconds later. That is the entry spread rule
      doing its job, but a day with wide spreads will add less than the rule's
      numbers suggest.
- [ ] **A market exit that fills in part** (the item above) matters more once
      positions can be 850: the rest of a Close now or stop watch exit would be
      left short.

---

## Times on a clock, a shorter strategy form, and swipe to confirm — 11 Sep 2026

Asked for:
- every time chosen on a clock with AM/PM;
- exit must come after entry;
- a latest time for the add, between entry and exit;
- a strategy form that does not scroll forever on a phone;
- Close now, Close all and selling from the chain to need a confirmation with
  the order and live P&L, and a swipe instead of a tap.

**Done (not deployed yet):**

- **Clock time picker** (`components/ui/time-picker.tsx`):
  - pick the hour on a dial, then the minute, then AM or PM;
  - ±1 minute buttons (5:29 is not on a five-minute dial), presets, and a text
    box that takes "5:29 pm", "1729" and "0530";
  - times outside the allowed range are greyed out and cannot be set;
  - used for entry, exit, the latest time to add, and the research date-time
    picker.
- **Times are still stored and sent as 24-hour "HH:MM" IST**, and shown as
  12-hour everywhere a strategy time is read: the form, the sentence, the
  strategy list, the "waiting for 5:30 AM IST" status and the Telegram
  missed-entry alert.
- **Validation, the same on screen and on the server:**
  - exit must be later than entry;
  - an entry before 5:30 PM cannot exit at or after the 5:30 PM settlement (an
    evening entry holds tomorrow's contract and may exit later that evening);
  - the latest time to add must fall strictly between entry and exit;
  - every message says the times as they are read, e.g. "Exit (6:00 AM) must be
    later in the day than entry (9:00 AM)."
- **Latest time to add** (`addToOpposite.addUntil`) replaces the fixed "not in
  the last 30 minutes". The default is 30 minutes before the strategy's own
  exit. Migration `007-add-until` writes it into saved strategies that have the
  add on but no time; reading an older row fills the same default.
- **Strategy form:**
  - four tabs: When · Sell · Entry & exit · Extras;
  - on/off settings are switches, choices are one-line segmented controls, and
    short number fields sit two to a row;
  - the rule sentence folds to two lines;
  - a problem is written under its field, its tab gets a red dot, and Save
    reads "Fix 2 to save" and jumps to the tab;
  - quick fixes: "Set exit to 5:29 PM" and "Use 4:59 PM".
  - Checked in a browser at 390px wide: When, Sell and Entry & exit fit without
    scrolling; Extras scrolls a little with the add switched on.
- **Swipe to confirm** (`components/ui/swipe-confirm.tsx`):
  - drag the thumb all the way right, and a tap or a part-way drag does nothing;
  - it springs back and shows "Sending…" / "Closing…" while the action runs;
  - it cannot fire twice, Enter confirms from a keyboard, and it respects
    reduced motion;
  - used on the chain order ticket ("Swipe to sell · ₹0.76"), Close now and
    Close all.
- **Close now** no longer closes on the first tap. It opens a sheet with:
  - the position (short 222, 425 sold, 203 bought back) and sold-at price;
  - price now, open P&L, booked so far and charges;
  - what is cancelled with it (target, stop, a working add);
  - a large live "If closed now" figure that refreshes with every poll.
- **Close all** shows each position's live P&L and "If closed", plus the total
  "If all closed now". The total is only shown when every position has a price.
- Tests: server 563 (new `test/strategy/times.test.ts`), web 353 (new time,
  rules, time picker, swipe and Close all tests; form, positions and ticket
  tests rewritten for the tabs and the swipe).

**To do:**

- [x] **Found on the live desk after the first deploy, and fixed (not deployed
      yet):**
      - on a 360×800 phone the time picker opened as a popover above the exit
        field and its top (the label and AM) went under the address bar. On a
        phone it now opens as a bottom sheet with room for the whole clock; a
        wide screen keeps the popover, capped to the space available.
      - a new strategy opened with a red dot on When and "1 thing to fix on
        When", and nothing on When was wrong: it was the empty name, which sits
        above the tabs. The name's problem is now written under the name box,
        only once it is touched or Save is pressed, and it marks no tab.
      - Save carried `aria-disabled` while pressing it is how the problems are
        shown. Removed.
- [ ] **Deploy** with nothing open, then open a strategy on the phone and check
      each tab and the clock.
- [ ] **The swipe has no touch-only alternative for a screen reader.** Keyboard
      Enter works, but VoiceOver or TalkBack users on a phone cannot drag. Add a
      "double-tap and hold" or a two-step button for assistive tech without
      weakening the guard against a stray touch.
- [ ] **Cancel order on a waiting order is still one tap.** It spends nothing
      and cannot open a position, so it was left alone. Decide whether it should
      ask too.
- [ ] **"If closed now" is priced at the mark** (the older item above). The
      Close now sheet makes that number the headline, so pricing it at the ask
      matters more now.
- [ ] **The order ticket swipe was not checked in a browser** (it needs a live
      chain to open). It is covered by tests. Look at it on the phone after
      deploying.
- [ ] **Other screens still write fixed times in 24-hour prose** ("since 05:30
      IST" on the Live screen, the account card, and Today's P&L). They are
      labels, not choices, but for consistency say "5:30 AM".
- [ ] **Edit exits** (moving a target or stop on a live position) saves on a
      tap. Consider the same confirmation.

---

## Security audit, two-step sign-in and sessions — 11 Sep 2026

Full audit in `docs/SECURITY-AUDIT.md`. **No trading logic was touched.**

**Fixed (not deployed yet):**

- 🔴 **Sign-in bypass.** The gate tested the text of the URL, and the router
  decodes it first: `/%61pi/strategies` reached every route with no session,
  including order placing. The gate now decides on the route Fastify matched.
- 🔴 **CORS answered every origin with credentials allowed.** Removed.
- 🔴 **The sign-in limiter could be walked past** by forging `X-Forwarded-For`.
  Only the proxies' own private ranges are trusted now, and sign-in is limited
  per account as well as per address.
- 🟠 **Two-step sign-in (Google Authenticator) is now required**, with QR setup
  at the first sign-in and ten single-use recovery codes.
- 🟠 **Sessions are rows in `auth.db`** (only the token's hash is stored), last
  24 hours, and can actually be ended: logging out, changing the password
  (ends every other one), or "sign out other devices".
- 🟠 **The page could be framed.** nginx does not inherit `add_header` into a
  location that has one, so the HTML went out with no `X-Frame-Options`. The
  headers are repeated per location, and CSP and Permissions-Policy added.
- 🟠 **CSRF:** a change now needs an `Origin`/`Referer` naming this host.
- 🟠 **Fail closed:** with sign-in unconfigured the API answers 503 instead of
  opening; the trading engine keeps running behind it.
- 🟡 **Change the password from the profile screen** (current password + a code),
  rate limits on sign-in only, sign-in refusals kept out of the error log,
  `hash-password.mjs` import fixed, `npm run auth` for repairs on the server.

**To do:**

- [ ] **Deploy, then sign in on the phone.** The first sign-in asks for the QR
      scan; **save the ten recovery codes** before closing the page. `.env`
      needs `DESK_SESSION_SECRET` set (32 random bytes: `openssl rand -base64 32`).
      If it is changed, 2FA must be set up again (`npm run auth -- reset-2fa`).
- [ ] **Publish the web port to loopback or the docker gateway only**
      (`127.0.0.1:8099:80` or a firewall rule), so nothing reaches the app
      except through the TLS edge. Needs care: the edge reaches it over
      `host.docker.internal`.
- [ ] **Rotate the Delta API key, the desk password and the Telegram token** —
      all three were pasted into chat at some point. The desk password can now
      be changed from the profile screen.
- [ ] **`/api/health` shows migration ids and counts** without sign-in. Narrow
      it to `{ok, days}` and move the rest behind the gate.
- [ ] **The swipe-to-confirm control has no touch-only path for screen readers**
      (from the earlier UI work) — still open.
- [ ] **HSTS `includeSubDomains`/`preload`** only once every `thannigo.in`
      subdomain is HTTPS.

**Next (asked for, not started):** performance and latency — web, server and
database — and using the machine's cores and memory. Note the engine itself
must stay one process: two copies would place the same order twice. The work
is in the heavy non-trading paths (chain fan-out, scoring, backtests), caching,
SQLite pragmas and indexes, and the browser bundle.

---

## The stop Delta refused six times — 12 Sep 2026

**What happened.** Between 06:09 and 06:10 the desk tried six times to place the
stop on a 850-lot short and Delta refused every one:

    unsupported — POST /v2/orders
    {"product_id": 151997, "size": 850, "side": "buy", "order_type": "market_order",
     "stop_order_type": "stop_loss_order", "stop_price": "10.5", "reduce_only": true}

**What `unsupported` means.** Delta's own wording: *"Market order couldn't be
validated for price impact as orderbook data isn't available."* The stop went
out as a **market** order with a trigger, and Delta will not accept a market
order for a contract with no order book — which is exactly the state a far
out-of-the-money option is in for most of the day. So the position ran with **no
stop at the exchange**, and only the desk's own watch behind it.

**Fixed (not deployed yet).**

- The stop is now a **stop-limit**: the same trigger, plus a limit priced
  *through* it (50% past the trigger, or five ticks, whichever is further). Delta
  validates that with no book at all. A trigger at 10.50 goes out with a limit at
  15.80; at 45, a limit at 67.50. Moving the stop moves both prices together.
- Any **reduce-only market order** Delta cannot price (`unsupported` or
  `no_liquidity_for_market_order`) is retried **once** as an aggressive limit
  through the touch, under the same client order id, so it cannot double up. An
  **entry is never retried** that way — only getting out is worth any price.
- The desk-side stop watch is unchanged and still the backstop.
- The Errors screen explains `unsupported` in one line.
- Tests: `test/trading/stop-orders.test.ts` (12) — the body Delta gets, where the
  limit sits, a penny option's five-tick floor, resting until the trigger,
  filling at the offer rather than at its own limit, a gap leaving it resting,
  the engine placing and moving it, and the three retry cases.

**Trade-off, said out loud.** A stop-limit can gap past its limit and stay
resting where a market order would have filled at any price. That is what the
desk's own stop watch is for, and it closes at the market when the mark goes
through the level.

**To do:**

- [ ] **Deploy with nothing open.** This is the urgent one: until it is
      deployed, every stop is still going out as a market order.
- [ ] **Watch the first live stop go on** and check on Delta that it shows as a
      stop-limit with both prices.
- [ ] **The 50% slack is a starting number, not a measured one.** Once a few
      stops have fired, check what they actually filled at against the trigger.

---

## Overnight strategies, and Delta's market hours — 12 Sep 2026

**Asked for:** a strategy entered at 11:30 PM with its exit at 5:30 AM would not
save — "exit must be later in the day than entry" refused it.

**Delta India's hours, checked rather than assumed** ([user
guide](https://guides.delta.exchange/delta-exchange-india-user-guide/derivatives-guide/options-guide),
[support](https://www.delta.exchange/support/solutions/articles/80001177914-when-do-the-contracts-expire-)):

- **All options expire at 5:30 PM IST.** Settlement is a 30-minute TWAP of the
  index.
- **The next day's D1/D2 chain is launched at that same 5:30 PM**, followed by a
  5-minute auction for price discovery.
- Trading is otherwise continuous — there is no session close overnight.

So an 11:30 PM entry sells a contract that was listed at 5:30 PM that evening
and expires at 5:30 PM the next day. A 5:30 AM exit is well inside its life, and
the real bound is not the clock but **the first 5:30 PM after the entry**.

**Done (not deployed yet).** One rule replaces both of the old ones, on the
server and in the form, in the same words: every time is measured **forwards
from the entry**, round midnight if it has to be, and the window must end before
the settlement that ends the contract it holds.

- 11:30 PM → 5:30 AM saves. So does 6:00 PM → 5:29 PM the next day.
- 9:00 AM → 6:00 AM does not: that is 21 hours and the contract expires at
  5:30 PM on the way. It now says so — *"Exit (6:00 AM) comes after the 5:30 PM
  settlement that ends the contract entered at 9:00 AM. The last exit is
  5:29 PM."* — instead of the old "must be later in the day".
- 5:00 PM → 5:30 AM still refused: that contract dies half an hour after entry.
- **The scheduler is anchored to the entry, not to the calendar day.** A slot
  keeps the date it began on, so an entry taken at 00:10 is still the previous
  day's 11:30 PM slot: it is judged on that day's weekday, the once-a-day guard
  is about that day, and the journal row is written under it. Writing it under
  the new date would have both lost the record and spent a day that had not run.
- **The exit no longer reads the clock.** It used to ask "is it past 5:30 AM",
  which at 11:35 PM is true — an overnight position would have been closed five
  minutes after it opened. It now asks whether the exit is due for the position
  this entry opened.
- **The latest time to add** is measured the same way, so 11:45 PM and 2:00 AM
  are both inside a 11:30 PM → 5:30 AM window.
- **The form:** the exit picker's allowed range wraps past midnight ("11:31 PM
  to 5:29 PM the next day"), the window length reads "Runs 6 h, into the next
  morning", and the sentence says "closes at 5:30 AM the next day".

Every existing daytime strategy behaves exactly as before — the same arithmetic
gives the same answers inside one day.

- Tests: server 629 (overnight entry, the slot surviving midnight, a Friday-only
  slot judged on Friday, not closing five minutes after opening, closing at 5:30
  the next morning, the window end, the add cutoff, and the settlement bound);
  web 381 (wrapping ranges, spans, the rules and the form).

**To do:**

- [ ] **Deploy with nothing open**, then create the 11:30 PM strategy and check
      the form saves it and the list shows the right next entry.
- [ ] **Watch one overnight run end to end.** The tests prove the arithmetic;
      only a live night proves the timing across midnight.
- [ ] **An entry between 5:30 PM and 5:35 PM lands in the launch auction.**
      Delta runs a 5-minute auction when the new chain lists. Nothing stops a
      strategy entering then, and the book in an auction is not a normal book.
      Worth refusing, or at least warning, once it has been seen.
- [ ] **A weekday means the day the slot began.** An 11:30 PM Friday strategy
      runs into Saturday, which is correct, but "Saturday" in the day picker
      still means a slot that *begins* on Saturday. Say so on the form.

---

## "The SL is not updating" — 12 Sep 2026

Reported from the live desk with a 76,000 PE on: **Target 0.60 · Stop none**,
and inside Edit exits, **"On Delta now · stop: none"** — while the same card
showed a green shield reading **PROTECTED**.

**What was actually wrong — three separate faults, stacked.**

1. **Delta never accepted the stop.** It went out as a *market* order with a
   trigger, and Delta refuses those on a contract with no order book
   (`unsupported`). Same fault as the section above; the fix is written and
   tested but **not deployed** — the running image (`7cfaef5-dirty`) does not
   contain it. Checked, not assumed: `stopFillLimit` is absent from the
   container.
2. **The desk filed a refused stop as placed.** The live record held
   `protection.stopLoss = "…S7"` — the eighth attempt — with `alarm: null` and
   phase `protected`. `missingProtection()` only asks whether *an id this trade
   owns* is recorded and whether the size matches; it never re-reads the book.
   So once an id was recorded, `protect()` was never called again and the
   position stayed naked. `absorb()` reads fills and rejections and ignores a
   protective order that came back **cancelled** — and Delta does cancel a
   reduce-only order it considers over-committed.
3. **The screen trusted that record.** `naked` was computed from
   `protection.stopLoss`, so the shield went green off the desk's own memory
   while `onBook.stop`, read from Delta, said none — the two contradicting each
   other an inch apart on the same card.

**Fixed (not deployed yet):**

- **A protective leg the exchange says is no longer resting is cleared** on the
  next poll, so `missingProtection` reads it as missing and `protect()` puts it
  back. It uses the lookups the poll already does, so it costs no extra call.
  Only on a definite answer and only when nothing filled: `getOrderByClientId`
  catches to null and cannot tell "no such order" from "could not ask", and
  treating an outage as "gone" would replace live protection for nothing.
- **The card reads the book, not the record.** `onBook` is now `null` when the
  book could not be read, which is a different fact from an empty book — a
  dropped poll must not raise an alarm. Unknown falls back to the record; a
  definite "no stop" with a stop wanted is red.
- **`onBook.stop` recognises a stop limit.** It matched `stop_market` only, so
  the moment the stop-limit fix deployed, every position would have read
  "Stop none" over a perfectly good stop. Caught before deploying, not after.

**To do:**

- [ ] **Deploy — this is the urgent one.** Until then every stop is still sent
      as a market order and can be refused. There is a position open right now,
      so weigh deploying with it on against leaving it without an exchange stop;
      the desk-side stop watch is the only thing behind it either way.
- [ ] **`reconciled` counts a target alone as "covered"** (machine.ts): with a
      stop wanted and only the target on the book, the phase still reads
      `protected`. Narrow `covered` to the stop when `wantsProtection`.
- [ ] **Alert on `POSITION UNPROTECTED`** — still screen-only, and this is the
      case that most needs a phone. (Already listed above; this incident is the
      argument for doing it.)
- [ ] **The error log was empty** when this was investigated, though the Errors
      screen had shown the six refusals earlier. Find out what cleared it — an
      audit trail that loses the incident is not one.

---

## Strike by position, and a friendlier market lean — 12 Sep 2026

**A second way to pick the strike.** Until now a strategy chose its strike by
premium — "at least $15" or "at most $15". It can now choose by **position**
instead: ATM, OTM 1..n, ITM 1..n. Whatever that strike pays, that is the one
sold.

- Counted over **the strikes Delta has actually listed** on that side, nearest
  the money first — not over the strike grid. Delta lists $200 apart near the
  money and $400 further out, so counting in grid steps would name contracts
  that do not exist.
- In the money is allowed under this rule and never under the premium rule. It
  is a different trade: it starts with intrinsic value against it, and the
  safety filter refuses it on almost any day it is on. The form says so.
- The safety gate, the lot doubling and every order gate are unchanged and
  still apply afterwards.
- Saved strategies read as `premium`, which is what they were doing. No
  migration: the store already fills defaults on read.
- Tests: 9 new in `test/strategy/select.test.ts` (each side's counting, ITM,
  a gapped board, the premium numbers being ignored, the refusal wording, and
  the gate still having its say). Server 638.

**Market lean, as an indicator.** It was three rows of "name · 40%" against
"downside, by 0.1 points" — a table of evidence with the reader left to do the
arithmetic. Now each input is a needle on the same Down-to-Up scale as the
headline, with the direction in words beside it; the exact figure stays, one
size down. It still says *for info only* in the title, because none of it held
up as a trading rule across all three years.

**How far BTC has moved** now covers **1m, 5m, 15m, 1h, 6h, 12h, 24h**. The
1-minute series is fetched for this table only — `agreement` and `regime` are
counted over five timeframes and adding a sixth would quietly change a number
on the screen that nobody asked to change.

**Collapse and expand are remembered** in the account sheet, the way the desk
cards already were (`usePersisted`, one key per section).

**To do:**

- [ ] **Deploy**, then check the moves table on the phone — seven rows is taller
      than four, and it sits under the contract card.
- [ ] **"By strike" has never been run live.** Try it on one lot at OTM 1 with
      the safety filter off before trusting it on a real day.
- [ ] **Nothing measured applies to a strike chosen by position.** The 733-day
      record is entirely premium-selected. The form should say that where the
      rule is chosen, not only here.
- [ ] **The 1-minute row can read as noise** — a single bar is often $0 and 0.00%.
      Worth showing a dash rather than a zero when nothing traded in it.

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

## Audit, 8 September

Ran over the whole tree: dead files, secrets, silent failures, the databases.

**Fixed here.** `delta/account.ts` had no importers once the account route went.
The order path swallowed five cancel failures silently, which is what hid the
book/screen divergence for as long as it did — best-effort is right for a
cleanup call, but best-effort and silent are not the same thing, and they are
warnings in the error log now.

**Still open, and the important one:** `app/server/.env` holds the API key that
was pasted into a chat. It is gitignored and has never been committed — that
much is verified — but a key that has been in a chat log is a public key. It
needs deleting on Delta and replacing, ideally with an IP allowlist. Nothing
else on this list matters next to it.

## What the Delta docs changed

Read properly rather than assumed, and two things came out of it.

**`PUT /v2/orders` edits an order in place.** Delta takes the id, the product,
the size and whichever price applies, and moves the order without it leaving
the book. That is strictly better than cancel-and-replace and it removes the
failure this desk kept hitting: no window where the position is unprotected, and
no moment where two reduce-only orders exist for the exchange to choose between.
`protect()` prefers it and falls back to the verified cancel-then-place for a
venue that refuses an edit.

**Rate limits: 20,000 per rolling five minutes**, weighted — 5 for placing,
editing or cancelling, 3 for reading orders or balances, 10 for history. This
desk polls at roughly four reads a second, which is about 1,200 a window against
20,000, so the limit is not close. A 429 is nonetheless handled distinctly now:
`X-RATE-LIMIT-RESET` says how long to wait, and anything that takes risk treats
being asked to wait as an outage rather than pushing through.

Not used, and each for a reason: `DELETE /v2/orders/all` (too blunt while a
position needs its stop), `POST /v2/orders/batch` (nothing places more than two
orders at once), and `trail_amount` for trailing stops, which is still the
single most valuable thing not yet built.

## Which price to sell at

Answered from the book rather than from preference.

    contract      bid    ask   spread   extra if you rest
    81,200 CE      17     19    11.1%              12%
    76,600 PE      32     34     6.1%               6%
    76,600 PE      24     27    11.8%              12%
    82,000 CE      15     17    12.5%              13%

Delta charges 0.01% to make and 0.01% to take — the same. There is no maker
rebate, so the only prize for resting is the spread itself, and on these
contracts that is 6–13% of the premium.

Against that: the 733-day record priced every fill at the **bid**. Profit factor
1.93 and a 95.8% win rate all assume you took the bid, so selling at the offer
cannot be worse than the record — it can only be unfilled.

And unfilled is the expensive outcome. The edge comes from holding the short
through twelve hours of decay, so missing the entry costs the whole day's
premium, not the spread. Resting alone is therefore worth it only while it
fills often enough:

    (1 − miss) × 1.12 > 1.00   →   miss < 10.7%

Roughly: if the offer goes untaken more than one day in nine, always taking the
bid wins.

**Rest at the offer, and cross after a wait.** That removes the condition
rather than betting on it: if someone lifts the offer you are ~12% ahead, and if
nobody does you cross and get exactly what taking the bid would have given.
There is no day on which it is worse than the record's own assumption, so it is
the default rather than a setting to be found — offer, cross after 30s.

Still unknown, and worth measuring once there are enough trades: **how often the
offer actually fills within thirty seconds.** If it is above 90% the wait could
be longer; if it is very low the wait is just a delayed market order. The
journal records every entry with its timestamps, so `/api/trade/history` already
holds the data to answer it.

## Getting filled on a wide book

The offer sat unfilled for thirty seconds on a real order, which is the
question this section exists to answer. What the research says, and it is
consistent across sources:

- **Never send a market order for an option.** Case 07 in the server suite is
  the demonstration: a market sell for 100 walked three levels — 40 at 99.80,
  40 at 99.50, 20 at 99.10 — for an average of 99.54 against a touch of 99.80.
  A quarter of a point given away on a book that was showing a better price. A
  limit at the bid is just as immediate and cannot do it, because a limit price
  is a floor for a seller. The market button is gone; "now" is a limit at the
  bid.
- **Step the price toward the bid rather than choosing once.** Offering at the
  ask and waiting is all-or-nothing, and on a 12% spread it often just sits.
  Conceding a little at a time gives a maker who will meet you halfway the
  chance to, and you keep part of the spread instead of none of it.

So the entry is a chase: start at the offer and walk to the bid in four steps
over the window, moving the order with `PUT /v2/orders` so it never leaves the
book. The last step is the bid, which is marketable, so a chase always ends in
a fill — the older "wait, then cross" is gone, since it was the same idea with
one step and a gap in the middle.

Still to measure, and the journal already holds the data: **where in the walk
fills actually happen.** If most land on the first step the walk is too fast
and is giving away spread; if most land on the last it is too slow and is only
a delayed market order. Four steps over thirty seconds is a starting guess, not
a measured number.

## Prices on screen must come from the book

The exits panel was headed "on the book now" and read the plan. They agree
until they do not, and the case where they differ is the only one worth showing
— a plan saying 1.90 while Delta's book held 20.80. Both the panel and the
position row read the exchange's resting orders now, and the panel says so
plainly when the two have drifted apart.

The general rule, since it has now been broken twice: **anything labelled as
what the exchange is doing must be read from the exchange.** The plan is what
was asked for.

### The third break, which cost money

A short sold at 7.00 with its target at 0.50 bought itself back at 7.00 less
than four seconds later. Then again on the next trade, at 6.00 against a sale
at 5.90. Both at a loss, both within seconds of the entry filling.

The cause was a change made an hour earlier for a real reason: a resting limit
buy only fills when somebody *offers* at it, so a decayed option's mark can fall
straight through the target untouched — which is exactly what the 2.70 → 1.10
trade did. The target was changed to a `take_profit_order` trigger so the
exchange would fire it on the mark. Delta fires a *buy* trigger in the opposite
direction to the one the docs read as, so it fired the moment it landed.

What makes this the same rule rather than a new one: **the suite agreed with the
bug.** Five tests asserted the target fired at the right moment and all five
passed, because `PaperExchange` had been written to the same reading of the docs
as the engine. A simulator built from the code's assumption cannot test that
assumption. It only tests that the code is consistent with itself.

So the corollary, which is the part that was missing:

> A simulator is only evidence about *our* logic. Anything the venue decides —
> trigger direction, fill semantics, what a field means — is evidence only when
> observed at the venue, or reduced to a property that holds whichever way the
> venue works.

The target is a resting limit again. (For a while the level was also judged
in `takeProfitIfReached`, closing at the market when the mark reached it; on
10 September that bought back at a 2.00 offer against a 1.00 target, so the
target is now only the resting limit — see "A target must never cross the
spread".) The stop stays a trigger at Delta because it is the only protection
that survives this process dying — and it is watched here as well, from both
ends. Case 80 is the reproduction; case 80b is the venue-independent property
worth keeping: an exit may never print worse than the level that asked for it.

**Still unverified:** whether Delta's *stop* direction is the one assumed. It
has never been observed misfiring, and a buy stop above the market is the
conventional case, but the take-profit was conventional too. It wants one
deliberate live test with one lot before it is trusted further.

## The bug behind "SL and TGT update not working"

It was one line of SQL. `SqliteTradeStore.save` upserted with

    ON CONFLICT(trade_id) DO UPDATE SET
      phase = ..., position = ..., state = ..., updated_at = ...

and no `plan`. So the plan was written once, on insert, and never again. Every
later change to it was lost on the next read.

That is why the reports were so confusing. The exchange was doing the right
thing throughout — `protect()` worked from the in-memory plan and moved the
order correctly, which is why Delta's book went 23.60 → 20.80 → 25.10 exactly
as asked. The desk then re-read the row, got the original 1.90 back, and every
screen that trusted the plan showed a level that had not existed for an hour.

Three separate symptoms, one cause: the exits "not updating", the bar seeded at
−94% beside a book holding 25.10, and the panel headed "on the book now"
disagreeing with Delta.

Four store tests now cover it, the first being a plan changed and read back.
The wider lesson is the one already written above and now demonstrated: a
screen that says what the exchange is doing must read it from the exchange. Had
the panel done that from the start, the DB bug would have been visible in
minutes rather than across an evening.


## A target that never fired

Reported: a short at 2.70 with a target at 1.10, marked at 1.00, still open.
Then marked at 0.94, still open.

The target was a plain resting **limit buy** at 1.10. A limit buy fills when
somebody *offers* at or below it — and on a decayed option the book is
something like 0.50 bid / 1.50 offered, so the mark fell straight through 1.10
while the offer never came near it. The order was doing exactly what a limit
order does. It was the wrong instrument for the job.

The stop was already right: a `stop_loss_order` triggered on the mark. The
target is now its mirror, a `stop_order_type: take_profit_order` on the same
trigger, so the two legs are the same kind of thing pointing opposite ways —
one fires when the price runs against the position, the other when it runs its
way. Both round towards firing rather than towards a better price, because a
target that misses by a tick is a target that does not exist.

The cost is that a trigger buys at the market when it fires, so it pays the
offer rather than waiting for one. On a residual worth a tenth of a cent that
is the right trade: getting out is the entire point of a target.

Five tests, the first being the reported case exactly — the mark through the
level while the offer stays well above it.

## What the premium floor means

"Premium 4 is under the 5 floor" was a true sentence that explained nothing.

The floor is in the exchange's quoted units: a price of 5 is 5 USD per BTC,
which on a 0.001 BTC contract is half a cent. The number looks small because
the unit is small.

Why it exists: the margin at risk does not shrink when the option is cheaper.
The same close-out distance, the same worst case, less credit for taking it.
The 733-day sweep put numbers on it — over the same days, selecting the same
way, a $0 floor returned $72 and a $15 floor returned $173.

The message now says that rather than quoting two numbers: *"This one pays 4.00
and the desk will not sell below 5.00 — the same margin is at risk either way,
so a cheaper option is the same risk for less pay."*

Still worth settling: the trading gate floors at 5 and the chain's own setting
defaults to 15, which is the researched figure. Two numbers for one idea, and
the sweep says the higher one is right.
