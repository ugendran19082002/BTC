# TODO

Live: https://delta.thannigo.in
Updated 14 Sep 2026

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
lasts a week; eight wrong attempts locks that address out for ten minutes.

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

- **A second sweep of the live screen on a real phone.** The panels are all
  responsive and tested at 400px, but every one of the faults above was found
  by somebody *looking* at the screen, not by a test — the readings were right
  and the controls were lying about them.
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

## A P&L screen, and an add the desk lost sight of — 14 Sep 2026

**The add that went missing.** 08:15 IST: an add of 100 was acknowledged by
Delta (order 1535448471), the next lookup found it nowhere, the desk wrote
"the order never reached the exchange" and stopped tracking it — while it
filled at 23. The person added again. Delta then held 1,500 CE against a
record of 1,400, and the account card's 1,510 (Delta's number) disagreed with
the position card's 1,400 (ours). Read from Delta's own API afterwards: both
adds filled, and the resting target was already 1,500, so nothing was
uncovered — but the record was wrong and would have stayed wrong.

Why the lookup lied: **`/v2/orders/history` ignores `client_order_id`** —
verified, two ids returned the same newest five — and a just-filled order
leaves `/v2/orders` at once but can take a moment to appear in history. In
that moment "nowhere" was the answer, and "nowhere" was read as "never sent".
Three changes, each closing a different hole:

- `getOrderById` — `GET /v2/orders/{id}`, by the number Delta gave the order
  in its acknowledgement. The add keeps that id (`AddWorking.orderId`), and
  `findAdd` asks by it whenever the client-id lookup is empty. A numbered order
  cannot be missed by a filter.
- A refused read is **unknown**, not absent. `getOrderByClientId` used to turn
  any 4xx into `[]`; it now throws, and the engine's "could not ask" path asks
  again next poll.
- An acknowledged add is never written off. Not found inside its window: keep
  looking. Not found by the end of it: read the position back from the
  exchange, let `protect()` cover what is there, and say what happened. Only a
  submit that got *no answer* can still end as "never reached the exchange".

**And the fills come back, not just the number.** A reconcile that found the
exchange holding more than the record used to write a bare `reconciled`
event: position 1,500, "Sold 1,400" still on the card, no price for the
difference. It now reads the contract's order history first
(`getOrderHistory`), and every filled order carrying this trade's own client-id
stem — `roleOfClientId` — is absorbed as the fill it was. `absorb` adds only
what it has not seen for that order, so the ones already on the record add
nothing, and a position the fills explain needs no `reconciled` event at all.
The card then reads "Sold 1,500 @ 11.82", which is Delta's figure. The
position card says, in words, when Delta holds more than the record sold,
with a **Re-read from Delta** button beside it (`POST /api/trade/reconcile`,
which existed and had no button). Startup reconcile does the same on deploy.

For the record, Delta's own fills on C-BTC-78800 that day: 650 @ 10.00,
650 @ 9.90, 100 @ 23.00, 100 @ 25.00 — 1,500, at an average of 11.82, which is
the figure Delta's position row carried. The account card's 1,510 was Delta's
number and was right; the position card's 1,400 was ours and was not.

**The P&L screen.** A sixth tab. Three views of the one journal:

- *The calendar* — every day in the range as a square, green or red, four
  shades against the biggest day. Realised P&L is booked on the IST day of the
  **exit fill** that booked it, one term per buy-back off the trade's final
  entry average, so the days add up to the trades and a Friday-night short
  closed on Monday is Monday's money. Charges land on the day of their fill.
- *The running total* — the cumulative line, with the charges toggle
  recomputing every square and every total together.
- *The day, minute by minute* — the same "net today" figure as the header
  (`todayFigures()`, one computation for both), written to `mtm_samples` in
  trades.db once a minute while something is on; the line, the low and high
  with their times, and the worst fall from a high — which is not the minimum,
  and the test says why. Kept ninety days. Migration `008` — the strategy
  store shares the ledger, so the sequence continues from its 007.

CSV of the days, a date range with quick picks, IST throughout. Phone: months
scroll sideways at seven squares wide, the figures fold to two columns.

---

## Add lots by hand — 14 Sep 2026

The position card gained **Add lots** beside Edit exits, for selling more of a
contract already held. It goes through the same engine path the strategy's
adds take — `addToPosition`, the same `add_submitted` / `add_done` journal, the
same single position with one average and one target and stop resized to
cover all of it — so a hand add and a strategy add are one thing to reason
about. `AddSource` gained `{ manual: true }`; records written before it carry
the old shape and read as it. No schema change: adds live in `trade_events`.

**Two steps, like the ticket.** `POST /api/trade/add/preview` runs every gate —
margin, the short cap, the daily loss, the spread, the feed — and prices the
add in money: the credit, Delta's charges to open, the margin the exchange
will hold, and the average the position moves to. `POST /api/trade/add` runs
the same gates again and sends. `engine.previewAdd` and `addInner` share
`addEligibility`, so the sheet can never offer a size the engine then refuses
on a check the sheet did not know about. Both answer 422 with the reasons.

**A typed price is the floor.** An add "at 9.50" is never sold under 9.50.
Blank, it starts at the ask and may walk to the bid over five seconds, not
past it. The input parser is its own pure module (`http/add-body.ts`) with
every objection returned at once; the money gates are the engine's, run once
on the preview and again on the add, never re-implemented in the route.

Sending takes a swipe, as anything that creates risk does here. The card
offers the button only on a short that is open and not already adding.

Tested: the parser's bounds and the floor rule; the preview's figures and that
it refuses on the short cap exactly as the add does; a hand add landing under
the same trade marked as by hand; the alert wording; the sheet sending the
previewed body and only on a full swipe, keeping the swipe dead while the
gates say no, and staying open with the reason when the send is refused.

---

## "add chase failed" over a trade that went right — 14 Sep 2026

07:37 IST, in the error log: *add chase failed: Delta refused the request
(open_order_not_found)*, order 1535388639, C-BTC-78800-140926. The journal for
the same minute: the add of 650 contracts at 9.90 was submitted at 07:37:43
and filled, all 650, at 07:37:48. The chase's first step — 1.25 s in — tried to
walk an order that had already gone, Delta said so, and the desk logged it as
a failure. The next poll found the fill and closed the add out correctly. The
outcome was right; the reporting was wrong, and the fill was on the record a
poll later than it needed to be.

Delta's own edit-order table names the fact twice — `open_order_not_found`
("may already be filled or cancelled") and `order_already_filled` — and
neither is a refusal of anything. `exchange/port.ts` gained `OrderGone`,
`exchange/delta.ts` maps both codes to it, and the paper venue throws the same
for an order that is not live, so the tests run against the answer the real
venue gives. In both chase loops the engine now reads the order again on
`OrderGone` instead of noting an error: the fill goes on the record in the
same poll, the add is closed out, and the target and stop are resized there
rather than twenty seconds later. Every other edit refusal is still reported.

Tested: the adapter maps both codes and nothing else; an add that fills under
the chase leaves the error log empty, lands at −850 in that poll and resizes
protection to 850 in the same poll; the entry chase does the same; a chase
refused for any other reason is still reported. The rig now records what the
engine swallows, so "nothing reached the error log" is an assertion.

`docs/DELTA-API-NOTES.md` is new: what the desk relies on from the API docs,
verified today, each with where the dependency lives — the error tables, what
a refused cancel means, why orders are read back from two endpoints, and the
rate-limit weights.

---

## Two score bars on a strategy — 14 Sep 2026

A strategy can now be held back by either of the two numbers the live screen
already shows, and each is off until it is switched on.

**The sudden-move limit waits.** `maxShockScore`, 1-100: the desk enters only
while `domain/shock.ts`'s five-minute reading is at or under the bar. Above it
the strategy is **held, not refused** — nothing is claimed, the next tick looks
again, and if the entry window closes still above the bar the missed-entry
alert says nothing was tried. "Enter when it is calm" is what was asked for,
and a gate that burned the whole day on one noisy five minutes would be a
different rule. The five-minute window is the one the live screen shows by
default, so the number a person sees is the number the gate uses.

**The sell-score bar refuses.** `minSellScore`, 1-100: a leg the strike rule
picks but the board's own sell score will not have is stood down for the day,
exactly as the probability gate stands one down — the strike is what it is, and
asking again in twenty seconds gets the same answer. The score comes from
`attachEv`, the same arithmetic the board draws, because a bar checked against
a privately recomputed number is a bar nobody can check.

**An unread risk is not a calm one.** Both refuse what they cannot read: a desk
one minute old has no volatility history and no open-interest history, so it
can take no reading at all, and treating that as calm would open the gate
widest exactly when it knows least. Absent is not zero, here as everywhere.

**No migration.** The config is JSON in a TEXT column and `hydrate` merges
`DEFAULT_CONFIG` over what it reads, so every strategy saved before today comes
back with both bars `null` — off, which is what they have been doing. A
migration writing a number into them would be a migration that changed what
saved strategies do.

**The screen stopped saying "due now" while the desk waited.** `schedule.ts`
answers from the clock alone, so a held strategy read "due now" minute after
minute with nothing happening. `strategy/holds.ts` keeps the reason in memory —
a hold is true of this minute and nothing else, and a restart is allowed to
forget it — and `statusOf` puts it where the screen already prints the clock's
answer. A hold outranks "due now" and never outranks "already ran today".

Where each part lives, and why: the two decisions are pure and tested by hand
(`strategy/gate.ts`, and the bar inside `selectLegs`); the runner only reads the
tape and calls them, which is the same split `select.ts` and `schedule.ts`
already keep. The reading itself is shaped in one place, `market/shock-now.ts`,
so the gate and the live screen cannot drift onto two different numbers.

Both are **untested as trading rules**, and differently untested from the
probability gate beside them: that one carries a 733-day record and neither of
these carries any. The form says so.

---

## A control that did nothing, and a chart that took the page — 14 Sep 2026

Four things reported from the live screen, all of them the same kind of fault:
a control that says it does something and does not.

**The odds block ignored the window.** "How often a move like this followed" was
counted over a fixed four hours while every other reading on the panel moved
with the 5m/15m/1h/4h control above it — so the one block a person is most
likely to read as a forecast was the one block the control did not reach. It
now counts over the window that was chosen. `moveOdds(win, 1)`.

At the short end a one-percent move is deep in the tail of five minutes *and*
of fifteen, so those two windows come back 1% / 1% / 98% alike. That is true,
and it still looks like a broken control, so the odds now also carry what the
window itself travels: the median measured move and the 95th, off the same 101
percentiles. Five minutes typically moves ±0.06% and fifteen ±0.10%, and
nineteen in twenty stay inside ±0.30% and ±0.52% — which is the figure that
actually separates them.

**The newest bar was drawn against the price axis.** The one bar the eye goes to
first had no room around it and its own price tag sat on top of it. A 26-unit
gutter now sits between the last candle and the axis; gridlines and level lines
still run the full width, so nothing is shortened but the bars.

**The walls could not be reached by zooming out.** The vertical zoom floor was a
flat 0.4, which widens a quiet hour's 600-dollar range to 1,500 — nowhere near
a wall six thousand dollars away, so both levels stayed pinned to the edges
reading "off the scale" however hard the scale was pulled. The floor is now
whatever brings the furthest wall inside with a little air around it, and never
tighter than it was. Zooming the price scale out is the one thing zooming out
is *for* on this chart, and it now does it.

**The chart took the wheel whether or not it was wanted.** It sits in the middle
of a long scrolling page, so a wheel that always zooms is a wheel that stops the
page dead wherever the pointer happens to rest — and `touch-action: none` meant
a drag over the plot on a phone scrolled nothing at all and the page felt stuck.
Zoom and pan are now armed by a toggle in the header, off by default and
remembered: off, the chart is a picture and the page behaves like a page;
armed, it takes the pointer and says so in the key. Turning it off keeps the
view exactly where it was — the first version snapped back to the whole series,
and the reason to turn zoom off is to *stop* the chart moving, not to have it
moved. Fit is there for the whole series.

**Every add in the journal now carries its date.** A bare "13:54" reads as
today's, and the journal keeps a week of them. The runs log beside it has
carried its run date all along, which is what made the gap look like a
formatting quirk rather than a missing fact.

Tested: the odds move with the window and the two short horizons are separated
by size, not by threshold; the wheel is left to the page until armed and
cancelled once it is; off-then-on still zooms; the last candle clears the axis;
and sixty notches on the price axis puts both walls on the scale with no "off
the scale" caveat left.

---

## Open interest over time, and whether something is happening — 14 Sep 2026

Delta's ticker carries open interest and nothing else — no previous value, no
delta — so a change is only readable if the desk remembers. It does now.

**`market.db`, a fourth database.** Market data is disposable and an order
history is not, which is why `trades.db` is its own file; the same argument puts
this one somewhere else again. `chain.db` would have been the natural home
except that it is read-only at runtime — `refresh.sh` replaces it wholesale with
a SQLite backup, and anything written into it is thrown away by the next
harvest. One row per strike per five-minute bucket, two days kept, pruned as it
writes. `test/env.ts` points it at a temp directory like the other three, and
`env.test.ts` fails if any of the four resolves inside the repository.

**The throttle asks the file, not a variable.** It began as a Map of the last
bucket written per expiry, which is a second copy of something the database
already knows — and the two come apart the moment a deploy or `refresh.sh`
replaces a file under a running process. One indexed lookup per poll is nothing
beside the write it is avoiding.

**A young desk answers over what it has.** The comparison takes the newest
bucket at or before the window asked for, and falls back to the oldest bucket
there is. Without the fallback the column is blank for a full hour after every
restart, which is most of the times anyone is watching it. `overMinutes` is what
keeps that honest — a window nobody can see the length of is one they read as
the window they asked for.

And the rule that runs through all of it: **absent is not zero.** Before the
first bucket there is no change to report, and the board prints a dash. "No
change" and "not running long enough to know" are different facts, and +0 on a
desk that started a minute ago is a lie about both.

### Whether something is happening right now

`domain/shock.ts`: five readings of the present tape under `SHOCK_WEIGHTS` —
how far BTC moved against how far it was *priced* to move (30), how busy the
tape is against its own 20-bar median (25), whether volatility is repricing
(20), whether open interest is turning over (15), how one-sided the board is
(10). A 0-100 score, a band, a direction, and the reasons in words.

Three things worth keeping:

- **The expected move is scaled to the window.** Comparing a five-minute move
  against a twelve-hour expectation is how a violent tape reads as calm.
- **A reading it cannot take scores as nothing, not as calm.** A desk one minute
  old has no volatility history and no open-interest history, and counting those
  absences as zeros reports a quiet market on the strength of not knowing —
  which is the one failure that would get somebody short into a move. When not
  one reading can be taken the score is null and the card draws nothing.
- **Direction is its own question.** The same violence scores the same whichever
  way it points; folding the two together hides which one the number answers.
  And it is pressure now, not a forecast: over 105,119 five-minute windows the
  chance BTC finishes higher never moved further than 0.6 points from a coin
  flip.

The median rather than the mean for volume, because one violent minute drags a
mean up enough that the next violent minute no longer looks unusual — the
opposite of what a spike detector is for. The newest bar is excluded from its
own median, and it is still forming, so a spike in progress is understated
rather than overstated.

Nothing on the trading side reads any of it, and the card says so.

### "Price now" was the one price nobody transacts at

The positions card showed the mark and called it the price. Closing a short is
a *buy*, so what leaving costs is the **ask** — the mirror of the rule the board
already follows for a seller, which is that you receive the bid and reading the
mark as your fill is how a profitable backtest turns into an account that is
not.

Both sides are on the card now, under the mark, with the spread beside the
other costs of leaving and marked when it is wide enough to matter. The close
sheet says "buys back at" outright, because that sheet exists to put everything
on the table before the swipe.

One side alone is not a book and is not drawn as one: "bid 10.50 · ask —" reads
as a quote that is half missing rather than as one the desk could not take.

### The board on a phone

Both sides is twenty-seven columns with the strike in the middle. That is how
an option chain is laid out everywhere and it is right on a desk; on a phone it
is the wrong shape twice over — too wide to read, and the one column you keep
your place with sits where nothing can pin it.

So on a narrow screen the board shows one side and the strike leads, pinned to
the left while the rest slides under it. The *stored* choice is untouched: a
phone does not quietly rewrite what a desk opens on, it only narrows what is
shown while the screen is narrow, and "Both" is disabled there rather than
silently absent.

It also opens on **what the desk picked** rather than on the money. Sixty-five
strikes exist and the ten around the pick are the ones being decided between;
the money can be nowhere near them.

The header span and the cells come from one list, so the one failure that
shape-shifting invites — a span claiming more columns than are drawn, which
reserves width for nothing and pushes the bid off the edge — is asserted for
all three views rather than hoped for.

### A sentence that would not wrap

The run log ran off the right of the card. A table on `auto` layout sizes each
column to its content, and one of those columns is a whole sentence, so the
table grew wider than the thing holding it. `fixed`, with a width on each of
the four narrow columns, hands the remainder to the sentence and lets it wrap —
which is the only column that should.

### The screen

Four readings and a direction, always: the risk out of 100, the move against
what it was priced for, the volume against its own median, whether volatility is
repricing, and which way the pressure points. The score alone is a number nobody
can check — the readings are what it is made of, so it can be argued with rather
than taken, and each carries the thing it is measured *against* because "3.2×"
means nothing without "the 20-bar median" beside it.

The *reasons* appear only once something is raised. A quiet tape should be one
glance, not a paragraph saying nothing is wrong.

### The chance it goes to zero, drawn as well as written

A bar behind the `→ 0` figure, the same device as the score's. It is the one
question a seller asks of every strike on the board, and a column of two dozen
percentages has to be read one at a time. The number stays: the bar is for
scanning, the number for deciding.

Both strategy logs became one table. They were fifteen bordered blocks each,
every one carrying a name, a time, an outcome and a sentence — thirty of those
is a page you scroll rather than read, when what a person is doing is scanning
one column for the day that went wrong. It is a real table on a desk and a stack
on a phone, not an `overflow-x` scroller: the chain is genuinely wide and every
column of it is a number compared downward, where this is four fields of which
one is a sentence, and a sentence in a ninety-pixel column is unreadable at any
width.

The strategy summary is clamped to two lines with the whole of it on hover. It
is every setting a strategy has in one sentence and runs to four lines on a
phone; Edit shows all of it anyway.

---

## A sell score, and columns you choose — 13 Sep 2026

The board answered "how likely" and then "what is it worth". It still could not
answer "which of these twenty". On a real chain most of the far half clears
every rule, so the Signal column read the same word twenty times down the page.

**A 0-100 score**, in `domain/ev.ts` under `SCORE_WEIGHTS`: distance 25, the
corrected probability 20, open interest 15, volume 10, implied volatility 10,
the premium 10, expected value 10. Open interest and volume are scored against
the *heaviest strike currently listed*, not against a constant — 425,600 is
heavy on one expiry and ordinary on another, and on a linear scale the heaviest
strike flattens every other to zero, so both are logged.

It ranks; it does not recommend. A board where everything scores 40 is a board
whose strikes are alike, not one to stand aside from, and none of these weights
has been near the cross-period screen the premium floor and the RSI gate went
through.

**The rules floor the tier in both directions.** A hard rule failing is `avoid`
whatever the score — otherwise an 84 quietly overrules a gate. A *soft* rule
failing caps the strike at `watch`: without that cap a thin strike paying twice
as much scores its way above one that clears everything, and the card recommends
the strike you cannot get out of. The score orders strikes inside a tier; it
never promotes across one. `ev.test.ts` pins both directions, including that the
capped strike really does score higher — the cap is what holds the order.

**An EV breakdown**, because a number nobody can check is a number nobody should
act on. The strike sheet now shows the chance it expires worthless, the credit,
the chance it breaches, the average cost *given* a breach, the charges, and then
the same arithmetic written out to the answer above it. The expected loss is the
payout model divided by the chance it is conditioned on, which is the one figure
there that is not read straight off the book.

Also on the strike: the credit as a return on the margin it ties up, and in
units of the expected move. A premium under one expected move is being paid less
than the distance it is exposed to.

**Columns are chosen one at a time.** The two presets were "key", which hid open
interest, and "all", which put twenty-seven columns on a phone; neither was what
anyone wanted. Every column is now a row in a picker that says what the column
is *for* rather than repeating its abbreviation. The bid cannot be turned off —
it is what a seller receives.

The span is derived from the same list that draws the cells, so the bug the old
comment warned about is now impossible to write: a hand-kept `perSide` that
over-claimed reserved width for columns that were not there and pushed the calls
bid off the left edge of a phone.

**Expected move** is on the card and shaded behind the candles, and a scenario
tile says what a 2% move does to the walls — two percent being roughly what a
losing day moved, against 0.63% on a winning one.

### Not done, and why

**Open-interest change.** Delta's ticker carries current open interest and
nothing else — no previous value, no delta. Reading it means the desk
remembering open interest over time: a table, a periodic write, a retention
rule. That is a storage decision rather than a calculation, so it is not guessed
at here. The OI-and-price interpretation table waits on it.

---

## Expected value on the board, and a strip above it — 13 Sep 2026

The screen showed how *likely* a strike was to expire worthless and never what
it was *worth*. Those are different questions and the probability column alone
answers the wrong one: a 99% strike paying $2 and a 94% strike paying $40 read
one way in the odds column and the other way once the average payout comes off.

**Expected value, per strike.** `domain/ev.ts` now prices every leg on the
board. The payout model is not a new one — it was lifted out of `recommend.ts`,
which now calls it, so the number on a strike and the number on the card above
it are one piece of arithmetic. `ev.test.ts` pins them to each other: the two
recommended legs' expected values must sum to exactly what the card reports.
Two EV models on one screen would sooner or later disagree about the same
option, and that is a screen nobody can act on.

The model is the one with provenance: `mark × (1 − real) / (1 − model)`, scaled
by how often strikes like this one actually breached. Two wrong versions
preceded it and the comment naming them moved to `ev.ts` with the code.
Averaging the payoff over the measured distribution of 12-hour moves — the
obvious thing to reach for — overstated the payout threefold, because that
distribution is unconditional.

**A Signal column, and what it is not.** Sell / Watch / Avoid, from nine
eligibility rules: distance, probability, expected value, the premium floor,
delta, liquidity, spread and staleness. It is marked *for information* wherever
it appears and no gate reads it. The premium floor and the RSI gate survived
2024, 2025 and 2026 separately; an EV rule has never been through that screen,
and the day it quietly starts refusing orders is the day this desk is trading
something it has not measured.

**Liquidity had to be a warning, not a refusal.** The first version blocked on
volume under 10% of open interest, which is the rule as it is usually written.
At the distance this strategy sells, a daily option routinely trades a fraction
of a percent — the strike the tested engine picked on 12 September traded 0.17%
of its open interest — so almost every genuine candidate failed it, the whole
far half of the board read unsellable, and "Best expected value" was empty and
saying "nothing qualifies". It now ranks warned-about strikes below clear ones
and marks them `thin`. "These qualify, and here is what is thin about them" is
a different statement from "nothing qualifies", and only one of them is true.

**Max pain and the open-interest band** are in `structure.ts` beside the walls
that were already there. Description, like everything else on that card.

**The screen.** A six-figure strip above everything — spot, implied volatility,
puts per call, both walls, max pain — because reading those six meant opening
three cards and scrolling past twenty strikes. A price chart under it with the
two walls drawn across it, 5m to 1D, volume and a crosshair. The strike itself
now opens a sheet with both its legs, the money, and every rule it passes or
fails; the board has room for six columns on a phone and the rule list is nine
long, and a phone has no hover to put a tooltip behind.

Three things came *off* the screen: the market-lean block (three needle bars and
five lines of prose for the one number on the card that is explicitly not a
forecast — it is one tile now), the Age column, and every settings control but
time and expiry. The values behind the removed controls still drive the chain
request at whatever was last chosen.

**One card, not a strip and a card.** The summary strip and the insights card
ran for an afternoon as two blocks, and the strip repeated support, resistance,
the put/call ratio and max pain straight out of the card below it — the same
number twice on one screen, which is how two figures eventually disagree. Nine
tiles in one card now, each with an icon, because ten identical grey tiles is a
wall.

The market lean is gone from the screen entirely. It was three needle bars and
five lines of prose in the Market card, then one tile, and now nothing: a
weighted read of three signals that were each tested and rejected is a number
with no use for it. `/api/chain` still returns `bias`, and `BiasSection` was
deleted rather than left as dead code.

**The layout.** Market insights and the chart share one row — the band means
nothing until you can see how close price is to its edges, and stacked they were
two full-width blocks with a scroll between them. The insights column is narrow
on purpose; its four tiles stack into it and the chart gets the width.

The chart was also letterboxed for a while: `width: 100%` with a `max-height`
makes a browser fit the viewBox to the *height* and centre it, so the candles
sat in a column down the middle of a wide card with blank space either side.
Height follows width from the viewBox's own ratio now.

**The chart's scale is price's, not the walls'.** The first version stretched
the axis to reach both walls so nothing was ever clipped. On a real board that
meant a 74,400–80,000 axis for a day that traded 76,000–78,000, and every candle
collapsed into a band a few pixels tall — legible about the walls, useless about
price. A wall outside the scale is pinned to the edge now, with an arrow and how
far away it is.

### A TDZ bug that reached the live desk

`Cannot access 'm' before initialization`, three times, in the Chain boundary at
16:16 IST. Mine: a `const at` lookup in `ChainTable` ended up declared *after*
the filter that used it. The suite caught it within the hour and it is fixed,
but it was built and deployed first — the error log is how it was found at all,
which is the argument for the error log.

### The suite was writing to the desk's error log

Two rows on the live desk, 72 folded occurrences between them:
`insufficient_margin` and `unsupported` on `POST /v2/orders`. Neither was real.
`client_order_id: "abc123E0"` is a fixture and the stack ends in `node:assert` —
`npm test` filed three more exchange refusals into the real `errors.db` on every
run. Four test files set `ERROR_DB` to a temp path themselves; every other file
that made the exchange refuse an order wrote to the desk's own database.

`test/env.ts` is preloaded with `--import` now, before any test module is
evaluated, and sets all three paths to a fresh temp directory. `env.test.ts`
asserts none of them resolve inside the repository, because this is exactly the
kind of thing that comes back. The two junk rows are still in the local log and
can be deleted from the Errors tab.

The cost was never tidiness. The error log is the one place a real failure is
supposed to be findable, and a suite filing three fake refusals per run is how a
real one gets scrolled past.

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
  a week (24 hours until 14 Sep 2026), and can actually be ended: logging out,
  changing the password (ends every other one), or "sign out other devices".
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
cards already were (`usePersisted`, one key per section). Everything else that
folds already remembered: the desk cards, the settings bar, the tab, the chain
width. The one place deliberately left alone is an **error row's** detail —
keying that by error id would write a localStorage entry per transient failure
and re-open last week's rows on every visit.

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

## "How far could BTC move" cards, redrawn like the reference — 17 Sep 2026

Asked for: the horizon cards to look like the reference image — label and
arrow, one big number, a small range, and a compact odds block with the
dominant figure highlighted.

**What changed (not deployed yet):**

- **Layout, not numbers.** Each card now reads: horizon and the chart's arrow
  on one line → **±$ move** as the headline → the range under it → a
  **cheap / fair / rich · 0.94×** chip → **Below / In range / Above** with the
  largest lit like a gauge's reading → "usually ±0.09%".
- The two-line uppercase "OPTIONS COST LESS THAN USUAL" is now the chip; the
  full sentence is on the chip's hover.
- "no chart for this" is now a short "no chart" in the arrow's place, still
  said in words rather than drawn as a flat arrow.
- On a phone: still two cards to a row, headline a size smaller.

**Deliberately not copied from the reference:** its "Down 52% / Side 38% /
Up 10%". That is a directional forecast, and the desk measured direction over
105,119 windows as a coin toss at every horizon (within 0.6 points of 50/50).
The three figures here stay Below / In range / Above the band the option market
is pricing — measured, not predicted — and the card's tests pin that no "Up" or
"Down" label ever appears. The reference's own settlement card uses
"Below / Within / Above", which is the same honest shape.

**To do:**

- [ ] **Deploy**, then look at it on the phone and on a laptop: ten cards at
      128px each, the ±$ headline at five figures, and the chip, all on one line.
- [ ] **The headline is the least surprising number on the card.** ±$ grows
      with √time, so it rises steadily from 5m to 24h; the chip is the figure
      that actually varies for a seller. If it reads as noise on the live
      board, swap them back.
- [ ] **"In range" is lit on almost every card**, because it is almost always
      the largest. Consider lighting it only when it clears two thirds (the
      "market charges more than it gets" line), so the highlight means
      something when it appears.

---

## Best-pick alerts: plain English, and the same strike once per contract — 17 Sep 2026

Asked for: the Telegram message was not easy to read, and the same strike
should be sent **once** per contract — from 5:31 PM to 5:30 PM the next day —
with the count settable on the card, one by default.

**The message.** It read like the card pasted into a chat: "rank 87/100 ·
Chance you keep it all: 100.0% · price gets there first: 3% · 3.20× the usual
move away · how easy to trade: 42/100", run together over three lines. Now it
is one fact per line with a label a person would use:

    🎯 New best pick · 11:30 AM IST
    Sell CE 78,800 · expires 18 Sep, 5:30 PM

    💰 You get: 6.00
    ✅ Chance it expires worthless: 100.0%
    📍 Chance the price reaches it first: 3%
    📏 Distance: 3.20× a normal move
    💧 Easy to trade: 42/100
    ⚠️ Max loss: no limit (no safety leg)
    ⭐ Score: 87/100

    👍 The tested rule picks this strike too.
    Only strikes paying $5 or more. Nothing was placed.
    🔁 Alert 1 of 1 for this strike before it expires.

**The repeat cap.** Before, the desk remembered only the *last* strike sent, so
a pick that went CE 78,800 → CE 79,000 → CE 78,800 announced 78,800 twice.
Now each strike is counted per contract, and sent at most N times:

- **N is 1 by default**, set on the card with a − / + stepper (1 to 10), shown
  once "Tell me when the pick changes" is on. Saved on the server, so it is the
  same on every phone and survives a deploy.
- **The window is the contract itself.** A contract lists at 5:30 PM and expires
  at 5:30 PM the next day, so counting per expiry *is* "5:31 PM to 5:30 PM" —
  with no clock to get wrong. A new contract starts from zero.
- Still silent while the same strike stays the pick, as before.
- Counted even with phone alerts off: turning them off is a choice to hear
  nothing, not a request to be told later.
- Switching the alert off and on again starts the count over — switching on is
  somebody asking to hear the current pick.
- Tests: 5 new server (the cap, a cap of 2, the new-contract reset, the 1–10
  bounds, the date label) and the message test rewritten; 4 new web.

**To do:**

- [ ] **Deploy**, then read one real message on the phone's lock screen — the
      emoji and line breaks are for that, and only a real Telegram shows them.
- [ ] **A pick sent while phone alerts were off is spent.** Deliberate, but if
      it surprises anyone, count only messages actually delivered.
- [ ] **"Score 87/100" has not been checked against past years** (the card says
      so). The message does not repeat that warning — decide whether it should.

---

## Sudden move analytics, redrawn — 17 Sep 2026

Asked for: the panel to be easier to read, and different.

What was wrong was not the styling but three contradictions on one screen: a red
**"High risk 58/100"** above **"98% stayed within 1%"**; a big green **"Upside
33%"** beside a tile reading **"Bearish"**; and support, resistance, max pain,
the 2% band and the open-interest range spread across five tiles when they are
points on one price line.

**Done (not deployed yet):**

- **The answer first, the evidence beside it.** The risk gauge sits next to what
  usually happened next, drawn as one bar (down / stayed within / up). When the
  score is raised but a 1% move has still been rare, it says so in words:
  "Busier than usual — but over the next 5 minutes a 1% move has been rare:
  98 in 100 stayed inside."
- **Direction as a push, not a forecast** — a small needle either side of a
  middle line, with its parts, and "A push right now, not a forecast."
- **Where BTC sits** — one price line with support, resistance, max pain, now,
  the expected move and the 2% band; labels in a two-column legend so nearby
  levels cannot overwrite each other.
- **Key numbers in plain words** — "more calls open" instead of "Bearish".
- No scoring logic or band label changed. Web tests +7; checked in a browser at
  desktop width with the live screenshot's numbers.

**To do:**

- [ ] **Deploy** and look at it on the phone with a real board.
- [ ] `MarketInsights.tsx` is no longer rendered anywhere (its tiles became the
      price line). Its tests still pass; delete it once the new panel is trusted.

---

## Measured Down / Side / Up, and the analytics service — 17 Sep 2026

Asked for: horizon cards like the reference image (a price, a range, an arrow,
Down / Side / Up on every card), with the logic and formulas upgraded, and
analytics split into a Python service.

**The one fact that decided the design.** The desk measured direction over
105,119 windows as a coin toss at every horizon, and the reference's own formula
(lognormal, risk-neutral drift) gives ~50/50 by construction. So its "Down 52% /
Up 10%" cannot come from data. Chosen instead: **the reference's look, with every
figure measured** — counted from what followed moments like this one.

**Measured** over 280,326 five-minute bars (Jan 2024 – Sep 2026), each state kept
only if it held in 2024, 2025 **and** 2026 separately (z > 3, non-overlapping):
18 of 81 readings survived.

- **Calm clusters, strongly.** After a quiet window, Side (stays in range) is
  ~44% against 33%, 5 minutes to 1 hour; after a move it drops to ~28%. For a
  seller this is the useful signal.
- **Direction leans are small and mean-reverting.** After a 15m–4h drop, Up is
  favoured by 5–6 points; RSI oversold → Up +6.6 at 5m. A trend-following score
  like the reference's would point the wrong way.
- **Nothing directional past 6 hours; nothing at all at 24 hours.** Those cards
  honestly read about even.

**Built (not deployed yet):**

- **`analytics/` — Python FastAPI service.** Measured outlook model; one copy of
  the RSI / EMA / momentum features shared by the measurement and the live
  labelling, so they cannot disagree; read-only table loader that reloads when
  the table is republished; no API docs exposed; input validated.
- **Node** calls it for display only (1.2 s timeout, 30 s back-off, one log line
  per outage) and attaches the rows by label. **Node's own outlook is untouched
  and still shown whenever the service does not answer.** Nothing on the trading
  path calls it.
- **Cards** in the reference's shape: projected price, range, arrow (only on a
  lean that held), Down / Side / Up with only a *held* outcome lit, the reason
  in words ("BTC fell over the last hour · livelier"), and the expiry card as
  Below / Within / Above. "How this is worked out" carries the formulas: EM,
  the lognormal P(up) ≈ 50%, the tercile Side band, the state, the hold rule.
- **Deploy:** `Dockerfile.analytics` (pinned, uid 1000, read-only, healthcheck),
  a compose service with no host port, `ANALYTICS_URL` on the API but no
  `depends_on`; deploy.sh runs its tests, tags/ships/prunes its image, reports
  its health without requiring it, and rolls back api and web only.
- Tests: analytics 24, server +8 (client), web +10. Image smoke-tested in an
  isolated hardened container (health, 28 ms answer, docs hidden, bad input 422).
  Cards checked in a browser at desktop and phone width on the real model output.
- Architecture and runbook: `docs/ANALYTICS.md`.

**Plain words on the desk's own cards (17 Sep).** Asked after "fair · 1.00×" and
"↗ +0.84" each needed explaining: the chip reads **Premium: fair / high / low**, the
arrow **Chart up · strong / Chart flat / Chart down**, the rows **Falls below / Stays
in range / Rises above**, "usually" is in dollars, the header says **Charts: 3 of 5
up, 1 flat · recent trend, not a forecast**, and a one-line legend explains a card.
The numbers are unchanged and on hover. Web tests +4.

**To do:**

- [ ] **Publish `outlook_states` to the live volume before or right after
      deploying** — it was measured into the repo's chain.db. Without it the
      service answers 503 and the cards show Node's own figures. Command in
      `docs/ANALYTICS.md` (run as uid 1000, not root).
- [ ] **Deploy**, then check `analytics: healthy` in the deploy output and one
      real board on the phone.
- [ ] **Record the option chain every 5 minutes** (PCR, total OI and its change,
      volume, ATM IV and skew, max-pain distance). The desk has no intraday
      history of any of them — `oi` keeps ~2 strikes a day — so OI, volume and
      PCR cannot be measured as inputs yet. After a few months, add them to
      `measure_outlook.py` under the same three-year hold rule.
- [ ] **Re-measure monthly.** `research/move-5min.csv` ends 10 Sep 2026; refresh
      it, re-run the measurement and the parity vectors, publish.
- [ ] **Joint states.** Each card uses its single most informative held reading;
      momentum and RSI are correlated and were not measured together. Measure
      the pairs before combining them.
- [ ] **Move the next display modules** (`forecast`, `direction`, `recommend`,
      `calibration`) one at a time, each with a parity test against Node's
      output before Node's copy is removed. Never a module the trading path
      imports — see the boundary in `docs/ANALYTICS.md`.

---

## Sudden move analytics, second layout — 17 Sep 2026

Asked for: the panel in the layout of a supplied design (a window dropdown, a
ring, a probability outlook bar, pricing vs history, trend score, key factors, a
price range line, IV / volume / open interest).

**Done (not deployed yet):**

- **Header:** window as a dropdown ("1 HOUR"), "Expires in 3h 12m", the risk
  level as the badge, last updated, Live, fold.
- **Row 1 — the answer:** the sudden-move risk ring (score and level inside) with
  the move and volume readings in words, and the "busier than usual — but rare"
  line when both are true; **Probability outlook** — the *measured* down /
  sideways / up for the chosen window, with the price at each threshold.
- **Row 2 — why:** Pricing vs history (1.00× FAIR, options imply ±$241, BTC
  usually moves ±$244); Right now (move vs expected, volume — each with its two
  numbers); Trend score, always marked "(past)"; Key factors (EMA / RSI / swing /
  VWAP — each part's share, adding to the score; options flow as one line).
- **Row 3 — where price sits:** a range line (spot, the implied band dashed, the
  usual band filled, the ±1% thresholds the odds counted); IV, options volume,
  open interest in BTC, the OI walls.
- **Kept honest inside the design:** the odds are counted, not forecast; the
  trend is the past; volume and OI show calls/puts splits, not "+12%" — the desk
  keeps no history to measure a change against.
- Server: the chart score now returns its parts (display only; the score is
  unchanged, and a test pins that the parts add up to it). Web tests rewritten
  (21). Checked in a browser at desktop and phone width.

**To do:**

- [ ] **Deploy** and look at a real board, especially a quiet one and a busy one.
- [ ] **Record options volume and open interest over time**, so a real "+x% in
      24h" can be shown instead of the calls/puts split.
- [ ] **Dead styles:** most of the old `.smr-*` rules in styles.css are unused
      now (`smr-context` and `smr-reasons` still are). Remove the rest.

---

## Desk bar, price chart and BTC summary — 17 Sep 2026

Asked for: the settings strip and the price chart in the layout of a supplied
design (BTC mark, Mode / Expiry / Refresh / Auto-refresh on one bar; a chart
card with OHLC, timeframes, fullscreen and Fit, walls with "% away", a legend;
a BTC SUMMARY column beside the chart).

**Done (not deployed yet):**

- **Desk bar** (replaces the folding "settings" box): BTC mark, Mode, the past
  date when a past mode is chosen, Expiry with "Xh left" and reset, Refresh and
  Auto-refresh as icon buttons (`aria-pressed`). Wraps to a stack on a phone.
- **Chart header:** "BTC • 5m", the last bar's O / H / L / C and its change
  against the bar before, "N of M bars"; timeframes; zoom lock, zoom out / in,
  fullscreen (browser fullscreen API) and Fit.
- **Walls on the chart:** "Resistance (+1.5% away)" beside the line; the
  off-scale label is unchanged. **Legend** under the chart with spot, support,
  resistance and volume values; the existing explanation lines kept.
- **BTC summary** (new `BtcSummary.tsx`): spot and 24h change, expiry and time
  left, the expected move for the chart's timeframe (from the outlook rows; 1m
  from IV), support / resistance with % away, the chart status (always "(past)")
  and a "holding above / below" line over the last 12 bars, and a note that the
  walls are open interest, not a settlement forecast.
- Chart height capped at 440px on wide screens so the summary column does not
  leave a gap. Nothing on the trading path touched.
- Tests: BtcSummary 7 new; PriceChart 43 pass; web suite 732 pass; tsc clean.
  Checked in a browser at desktop and phone width.

**To do:**

- [ ] **Deploy** and look at it with a live chart and a past date.
- [ ] **Label collision:** when spot sits right under an off-scale wall, the
      spot badge on the right axis covers the wall's badge. Nudge one of them.
- [ ] **Summary "holding" line** uses $500 steps; on a very quiet day a $250
      step would say more.

---

## The Live screen in the reference layout, and every card folds — 17 Sep 2026

Asked for: the Live screen like the supplied image (outlook header with an
"Overall lean" box, a Market card with the BTC mark and 24h change, the moves
and the can-move bars as cards, the best pick and its alerts as two cards); then
"all UI mobile responsive, collapse / expand for everything".

**Done (not deployed yet):**

- **Outlook header:** lightning mark, title and one-line subtitle, "How this is
  worked out", and an **Overall lean** box (words + signed score, the 0.45 bar
  and the 4-of-5 rule on hover). The verdict line under it no longer repeats the
  score, so there is one score on the screen.
- **"Side" says where it ends**, on every measured card: "Side = ±$76 (0.10%)".
  Asked on 17 Sep why the 5m card said 33 / 33 / 33 while the sudden-move panel
  said 1 / 98 / 1: neither is wrong — the card's Side is the middle third of
  what BTC did (±0.1% at 5m, so 33% each is "no information"), the panel's is
  ±1%. The panel now says "Sideways ±1%" and "a ±1% line, not the outlook
  cards' narrower band".
- **Market card** (`MarketHead.tsx`): BTC mark, BTC / USD, the price grouped
  with one decimal, the 24h change in $ and % (the same `return24h` as the BTC
  summary), and Settles / Contract / As of / ATM beside it. `istLabel` moved to
  `lib/format.ts`.
- **Moves as two cards** under Market, side by side when each gets 300px:
  grouped dollars, the desk minus sign, "today since 05:30" highlighted; the
  ladder in blue with "Now 76,233" and wider value column.
- **Best pick split in two:** the pick and its figures; then "Alerts for this
  pick" — switch, the premium floor and "same strike, at most" side by side
  under their own labels, the order button and the caveat.
- **Every card folds and remembers it** (localStorage `btc-desk:open:*`):
  outlook (folded, the header and lean box stay), Market, both move cards, both
  best-pick cards, BTC summary (folded, spot stays in the title), Account,
  Orders waiting, Open positions (the count stays in the title), Auto-trading,
  Strategies, Recent runs, Adds. Already folding: price chart, sudden move,
  what to sell, market insights, orders, errors, P&L.
- **`CollapsibleCard`:** the control beside the title is no longer inside the
  fold button (the Strategies "New" button was a button inside a button); the
  header wraps rather than truncating the title on a phone; the tap target is
  32px; `ariaLabel` names the card.
- **Phones:** every `auto-fit` grid floor is `min(Npx, 100%)`, so no grid can
  push the page wider than a 320px screen. Checked at 1536, 390 and 320 wide —
  no sideways scroll.
- Tests: MarketHead 5, MoveSection 5, collapsible card 4, outlook header /
  band / fold 5, best-pick split 2, BTC summary fold 1. Web suite 754 pass, tsc
  clean. Nothing on the trading path touched.

**To do:**

- [ ] **Deploy** and look at the Live screen on a real phone.
- [ ] **Open positions folded is a risk:** the count shows, but a stop that is
      not on the book does not. Put "unprotected" in the folded title too, or
      refuse to remember "folded" while anything is unprotected.
- [ ] **Screens not checked at 320px with live data:** Positions, Orders,
      Strategy form, P&L calendar, Errors. The grids are guarded; the tables
      scroll inside their cards — look at each once on a phone.
- [ ] **"By expiry · 10.9h"** still truncates in the measured card title on
      desktop widths; shorten to "Expiry · 10.9h" or let it wrap.
- [ ] **Old `.ol-howto` / `.ol-summary` Badge** text is long on a phone (three
      lines). Shorten.

---

## The option chain in the prediction, measured — 17 Sep 2026

Asked for: "OI, Vol, ΔOI, V/OI, Δ, IV, OTM, EM×, B/E, Score, Signal, EV, → 0,
Model, Touch, ≈0, Ask, Mark, Bid and the rest — use them all for a
multi-timeframe price prediction", with a reference showing per-horizon prices
and Down / Side / Up.

**The answer the measurement gave.** `research/measure_chain_outlook.py` counts
735 mornings in chain.db — every strike's mark and eight hours of volume at
05:30, against the 17:30 settle twelve hours later — the same way the candle
states were counted, and keeps only what held in 2024, 2025 and 2026 with z > 3:

- **A large implied move held** (`CHAIN-MEASURED.txt`): when the ATM straddle
  is in the top third, the day finished *outside* the Side band far more often
  — Side 19%, not 33%, in all three years. It says how far, never which way.
- **No chain reading held a direction.** Skew and put/call volume both looked
  like a lean overall (+0.07, −0.07) and neither pointed the same way in all
  three years. A card printing "Down 52% / Up 10%" from the board would be
  printing an invention.
- **Most columns cannot be measured at all yet.** chain.db has no open interest
  per strike, no ΔOI, no walls, no max pain, no V/OI — its `oi` table is the two
  strikes the strategy sold. EV, touch, near-zero and the score are figures the
  desk computes now, with no history of their own either.

**Done (not deployed yet):**

- **Recording, so the rest can be measured in a year** (`market/chain-features.ts`,
  `market.db` migration `003-chain-features`): one row per five-minute bucket per
  expiry — marks at the money and 2/3/4 strikes out, out-of-the-money volume,
  PCR OI and volume, CE/PE open interest, IV skew, both walls, max pain, and the
  hour's ΔOI each side. Live boards only; kept 400 days; throttled by asking the
  file, like the OI table beside it.
- **Shared definitions** (`analytics/app/chain_features.py`): implied move
  (the straddle, scaled by √t to the 12 hours it was measured on), skew (OTM
  puts against the calls the same distance out), put/call volume (a log ratio).
  The research script and the service import the same functions, and Node sends
  raw marks and volumes — it never buckets, so the two languages cannot drift.
- **The service** applies a chain reading **only to the settlement card**, which
  is the horizon it was measured on, and only when it held; it competes with the
  candle states on the same informativeness rule and carries its own Side band
  and percentiles. Every answer also returns `context`: each reading now, its
  bucket and whether it held. `/health` reports `chain_rows`.
- **The screen**: a strip under the cards — each reading, its value in plain
  units, what it means, and one of *counts*, *measured · did not hold*, or *no
  history yet*, with the unmeasurable board figures (PCR OI, IV skew, walls, max
  pain) shown as context beside them.
- Tests: analytics 41 (14 new), server 954, web 768. Nothing on the trading path
  touched.

**To do:**

- [ ] **Deploy, then publish** `chain_states` with the outlook states:
      `research/measure_chain_outlook.py` then `publish_outlook_states.py`
      (it copies both tables now). Until then the cards are exactly as they were.
- [ ] **Measure again in a year**, with `chain_features`: open interest and its
      change, the walls, max pain, V/OI — at every horizon, not only to
      settlement. That is the measurement that would let the chain speak on the
      5m … 24h cards at all.
- [ ] **Record the desk's own figures too** (EV, touch, near-zero, score,
      liquidity) in the same table, so "does a high score predict anything"
      becomes answerable rather than assumed.
- [ ] **The 05:30 parity gap:** put/call volume is 8 hours in the history and
      24 hours live. The ratio is close, not identical — either harvest a 24h
      volume into chain.db or measure the live column once there is a year of it.
- [ ] **A year needs 30 mornings a bucket**, not the 50 the candle states use.
      Stated in the script; worth revisiting once 2026 is complete.

---

## "If not filled, sell at bid after N seconds" — on adds too — 17 Sep 2026

Asked for: the order ticket's option on **Add lots** and on the strategy's
**Add to the other leg**.

**Done (not deployed yet):**

- **Add lots:** the ticket's control, on by default at 5 seconds — which is what
  every add by hand has done since the sheet existed. Switched off it rests at
  the ask and never crosses; the window still ends it. A typed price stays the
  floor either way, so crossing can never sell under it. The sentence under the
  sheet now says what it will actually do.
- **The strategy's add** carries its own seconds (`addToOpposite.crossAfterSec`,
  in the config JSON — no migration). Blank means the entry's own seconds, which
  is what every strategy saved before this did; zero rests at the offer; the
  minimum bid is still the floor; an entry priced "now" crosses at once and has
  nothing to wait for. Checked on save (0–600, whole seconds) on both sides.
- Tests: 4 new in the adder (the rule's seconds, the fallback, zero, "now"),
  validation and round-trip in the store, 5 in the add-lots sheet, 4 in the
  strategy form.

**To do:**

- [ ] **Deploy**, then watch one strategy add fill with its own seconds.
- [ ] **The preview sentence** in the strategy form's "Try it on prices" does not
      mention the walk; add it once there is a real add to check it against.

---

## Delta 504s on the status reads — 18 Sep 2026

Two rows at 01:53: `GET /v2/positions/margined` and `GET /v2/wallet/balances`,
both `http_504`, both `attempts: 2`.

Nothing is broken. A 504 is Delta's gateway timing out — Delta's trouble, not
Delta's answer — and the desk already treats it that way: the read is asked
again once automatically, the row is logged at *warn*, and the failure surfaces
as "unavailable" rather than as an answer, so nothing reads it as "no positions"
or "no balance". Both were the same minute and did not repeat.

**To do:**

- [ ] **Only if it repeats:** a 5xx that heals on the retry writes a warn row
      every time. Either fold it into one row with a count (the log already
      folds by message) or drop the row when the second attempt succeeded — the
      point of the log is that a real failure is findable.
- [ ] **The status screen asks Delta twice at once** (positions and balances in
      one `Promise.all`); a Delta wobble therefore always arrives as two rows.
      Worth one row saying "Delta was slow" instead.

---

## Selling the best pick by itself, and who placed what — 18 Sep 2026

Asked for: "auto trade, a config popup, 5 lots by default, sell entry, target
95%, no duplicates, real-time, full tests, UI + backend + DB"; and separately,
a label on every position and order saying whether it was a strategy order, the
best pick, or placed by hand.

**Done (not deployed yet, and off by default):**

- **The decision is pure and tested first** (`trading/auto-trade.ts`). An
  auto-trader is judged by what it refuses to do, so that is most of the file
  and most of its 11 tests: off unless armed; **never a "best of none"** (the
  card marks that one "not a recommendation" — a machine must not read past it);
  never the same strike twice on one contract; never past the cap (one trade per
  contract by default); never on top of a position the desk already carries,
  whoever opened it; and never again after the gates have refused a strike —
  otherwise Delta is asked the same refused question every minute for eleven
  hours.
- **The acting half** runs on the same once-a-minute tick as the best-pick
  alert, on the same board: the message first, then the order. The decision is
  **written down before the order goes out**, so a crash costs one missed trade
  rather than a second copy of one; a refusal is written too, with its reason,
  and announced once.
- **The order is the ticket's order.** `place()` with `origin: 'best-pick'` —
  same engine, same prechecks (margin, short cap, day's loss, spread), same
  protection. Nothing here can place an order a person could not place by hand.
- **Defaults:** 5 lots, target 95% (bought back at a twentieth of the sale
  price), no stop, walk to the bid over 5 seconds, one trade per contract. Every
  number is clamped on the way in, on both sides.
- **The popup** on the best-pick card shows the order it would place in words —
  "Sell CE 78,600 — 5 lots, target 95% (buy back near 0.51), no stop" — says
  **armed — real orders** in live mode, and lists what it has already sold or
  been refused on this contract, with "consider them again" as the one way back.
- **Who placed it:** `plan.origin` (`manual` | `strategy` | `best-pick`), written
  where it is known and carried into the API, the position cards, the orders
  rows, the CSV export and the Telegram footer. A record from before the field
  existed reads as manual, which is what it was.
- Tests: 11 for the rules, 5 end-to-end through the real service and journal,
  10 for the popup, 4 for the label. Server 970, web 782.

**To do — before arming it on the live desk:**

- [ ] **Watch it in paper mode for a full contract first.** Arm it, leave it,
      and read the journal the next morning: one order, the right size, the
      target where it should be.
- [ ] **A daily cap, not only a per-contract one.** The cap is per contract;
      on a day with two expiries listed it could place twice.
- [ ] **No stop by default is a naked short.** The engine says so loudly and the
      popup says "no stop", but decide whether an armed auto-trader should be
      allowed to hold one at all.
- [ ] **It does not stand aside on a sudden move.** The strategy runner has a
      shock gate; this has none — it only inherits the prechecks.
- [ ] **The ledger is one key/value row in the journal.** If auto-trading is
      kept, give it a table with a row per decision, like `strategy_adds`, so
      the history outlives the contract.
- [ ] **Label the P&L screen too** — the rows there still say nothing about who
      placed the trade.

---

## Dynamic one-sided rebalance — 18 Sep 2026

Asked for: sell both sides, and when one side rises 30% while the other falls
20%, buy back 30 lots of the fallen side and sell 30 more of the risen one;
then 40/30, then 50/40, "…n"; a cutoff at 13:30 and the hard exit at 17:29;
confirmation over consecutive readings; and every number set on the screen.

**Where the design differs from the ask, and why:**

- **The base is the actual fill per side, not the typed $15.** A CE filled at
  14.60 against a typed 15.00 fires 2.7% early at every stage, for ever. The
  typed number is the fallback where a leg has no fill.
- **Buy first, then sell.** If the buy-back fails the desk must end up *flatter*.
  Selling first and failing to buy is the one order that leaves more risk on
  than anybody asked for, so it is never used.
- **The direction locks at stage 1** (a setting). Without it a whipsaw buys the
  CE back at stage 1 and the PE back at stage 2: both spreads paid, one-sided in
  both directions inside a day.
- **One stage per evaluation, never skipping.** A gap past stage 3's thresholds
  fires stage 1 now and stage 2 on the next confirmed reading.
- **Partial last step** (a setting): 100 lots and 30 a step leaves 10, and 10 is
  what the last stage uses.
- **It adds to the losing side**, 100/100 → 70/130 → 40/160 → 10/190, so the cap
  per side, the spread gate and the stale-quote gate are part of the rule.

**Done (not deployed yet, and off by default):**

- `strategy/rebalance.ts` — the decision, pure: thresholds from the rule, the
  risen side found rather than assumed, the cutoff measured forward from entry
  (so an overnight 13:30 is the one after entry), the cap, the partial step, and
  a spread gate. 18 tests, including both boundaries (+29.93% / −19.93% does
  nothing; exactly +30 / −20 fires).
- `strategy/rebalancer.ts` — the acting half: N consecutive readings of the same
  stage and side, the stage written to `strategy_rebalances` **before** any
  order, `UNIQUE (strategy_id, run_date, stage)` so a restart or a second tick
  can never fire it twice, buy-back then sell, and a refusal recorded with its
  reason. 10 tests.
- Config, validation and routes: the rule lives in the strategy's own config
  (`rebalance`, null is off), is checked on both sides, and the last stage's
  fall is refused when it would need a price to drop more than 100%.
- **Every number is a setting.** `DEFAULT_REBALANCE` and `REBALANCE_LIMITS` are
  what the desk starts with, stored in `settings` and edited on the new
  **Settings** screen; the only numbers left in the source are
  `REBALANCE_CEILINGS`, which no setting may pass and which each box prints.
- The strategy form shows the stages as they are typed: each stage's percentages,
  what they mean in money from the sale price, and what the position becomes
  (100/100 → 70/130 → …).

**To do:**

- [ ] **Paper-trade a full contract before arming it live.** The rule is tested;
      the day it describes has not been traded.
- [ ] **The rebalance has no shock gate.** The entry has one; this only inherits
      the engine's prechecks.
- [ ] **Show the live stage on the strategy card** — stage 2 of 3, and what the
      next one needs, the way the design drawing does.
- [ ] **A stage that is skipped counts as done.** That is deliberate (it stops a
      loop), but it means one wide spread at the wrong moment costs a stage.
      Consider retrying a skip a fixed number of times.

---

## The rebalance sell's own seconds, and what the cap means — 18 Sep 2026

Two things the form was missing when the rule was first used.

**"If not filled, sell at bid after N sec" was not there.** The rebalance sell
rests at the risen side's offer, and by then the buy-back has already happened —
a sell nobody is watching leaves the stage half done. The rule now carries its
own seconds (`rebalance.crossAfterSec`): blank keeps the strategy's entry
seconds, zero rests at the offer and lets the five-minute window end it. The
widest spread it may cross is on the form beside it, where it was only a stored
number before.

**The cap blocked everything, silently.** The desk default is 200 lots a side
and the strategy sells 700, so every stage was refused before it started — the
form said the cap was under the lots but not what to do about it. Now:

- Turning the rule on sets the cap to **the most the rule can actually reach** —
  700 a side with 30 lots over 3 stages reaches 790 — so it fits by default and
  is lowered on purpose rather than by accident.
- The field says what it means for these numbers: "neither side may pass 790
  lots — this rule reaches 790".
- The stage table says it in words, and shows the cap holding: 100/100 → 130/70
  → 160/40 → 160/40 under a cap of 160.
- The error says why nothing could run and what the rule reaches.

---

## "I set 5 seconds and it still has not filled" — 18 Sep 2026

An add rested at 20.00 with the bid at 19.00 for an hour, with "if not filled,
sell at bid after 5 sec" switched on.

**Nothing was broken.** A typed price is also the add's floor — "sell 200 at
20.00" means never under 20.00 — so the walk toward the bid had nowhere to go.
The switch asked for a crossing the price forbade.

**Done:**

- The add preview returns the book (`bid`, `ask`) and `canWalk`, so the sheet
  says it **before** the order is sent: "Nothing to walk to: 20.00 is also the
  floor, and the bid is 19.00. Leave the price blank, or set it under the ask,
  for it to cross." With room it says the range instead: "Walks 20.00 → 19.00
  over 5 seconds."
- The position card says the same on a working add that cannot cross.
- Real walks pinned on the paper exchange: room to walk fills at the bid; a
  floor at the start price rests until the window closes; a bid that lifts to
  the ask fills at the ask without crossing at all.

---

## The cap works itself out; Settings would not open; the levels, cross-checked — 18 Sep 2026

**The rebalance cap is automatic, and editable.** `capAuto` (on for a new
rule): the cap is the most the rule can reach — lots plus what can move, bounded
by the other side, so 100 a side with 30 lots over 5 stages is 200, not 250 —
and it is recomputed on every save from the lots and stages as they are then.
"Edit" turns it into a typed number that stays put; "Auto" hands it back. A
typed cap that is too small says exactly what it does: *"The cap stops it after
stage 2: stage 3 is refused. Raise it to 190 for all 3."* — counted, not guessed
— and the stage table marks the capped rows. A cap with no room above the
opening lots says no stage can run.

**Settings did not open.** A tab lives in four places — the type, the nav, the
body and the runtime list a click is checked against — and Settings was added to
three. `tabs.test.ts` now holds every screen to the list.

**The levels, cross-checked against the board** (spot ≈ 76,860): puts within the
band held 145k at 76,000, 138k at 76,200, 42k at 76,400 — so 76,000 is right;
calls held 134k at 77,800 and 245k at 78,000, one strike further out and just
past two expected moves — so 77,800 is right *and* looks wrong. The arithmetic
was correct; the band chose. Now the card shows the open interest behind each
level and names the heavier strike outside the band ("78,000 holds 245k"), and
the band itself is a desk setting (`wall_within_em`, 0.25–20, on the Settings
screen) rather than a number in the source.

**To do:**

- [ ] **Deploy** — the levels, the cap and the Settings tab are all local.
- [ ] **Watch whether two expected moves is the right band** for the late
      afternoon, when the expected move to settlement is small and the band
      with it. If "none near" shows too often, the setting is there to widen.

---

## "Resistance 89,000" — 18 Sep 2026

The BTC summary called 89,000 resistance with BTC at 76,723 and ten hours left:
16% away, about eleven expected moves.

**Why:** the wall was "the strike with the largest call open interest anywhere
on the chain", and the board fetches a wide range of strikes. On Delta the far
round numbers carry real open interest from cheap lottery calls, so 89,000 beat
every strike near the money. There was no distance test at all.

**Done:** `ceOiWallNear` / `peOiWallNear` — the heaviest wall **within reach**,
default two expected moves, a call only above spot and a put only below it. The
summary and the chart draw those; where there is none they say "none near" and
name the far one rather than reaching out for something to draw. The whole-board
pair is still reported, and every wall now carries how far it sits in percent
and in expected moves.

**To do:**

- [ ] **Make the reach a desk setting** on the Settings screen — it is a
      parameter of `optionStructure` today, defaulted to 2.
- [ ] **The sudden-move panel still prints the far pair** as "OI walls". Decide
      whether that panel wants the near pair too.

---

## A Settings screen — 18 Sep 2026

Asked for: all the numbers dynamic, and settings in a menu of their own.

**Done:** a **Settings** tab. The automatic best-pick trade's limits (most lots,
the target range, the stop ceiling, the longest walk, trades per contract) and
the rebalance defaults and limits are read from the server and written back —
they were constants in the source, which meant a deploy to change a ceiling.
Each box prints the hard ceiling it cannot pass. Nothing on the screen places an
order: the switches that do are where the orders are.

**To do:**

- [ ] **Move the rest of the desk's numbers here**: the premium floor, the alert
      repeat, the short cap and the daily loss limit are still on their own
      cards.
- [ ] **Say who changed a limit and when.** These are settings that widen what
      an automatic order may do; the journal should carry them.

---

## Found while doing the above — 17 Sep 2026

- [ ] **The chain harvester is not scheduled.** No cron or systemd unit runs it;
      the last day in `chain.db` is 8 Sep 2026. It also cannot run as uid 1000:
      `chain.db` is owned by 1001 while its -wal / -shm are 1000. Decide the
      owner, fix it once (never as root), then schedule it. The measured outlook
      only learns from what is harvested.
- [ ] **Analytics start-up log noise:** the API can ask the analytics service
      before uvicorn is up, logging one "fetch failed". Log only after a second
      failure in a row (the fallback cards already cover the gap).
- [ ] **Analytics wording fix is not live:** "BTC was quiet over the last {h}"
      is in the code, not in the running container. Goes out with the next
      analytics deploy.

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

## A week signed in

*14 September 2026*

A session lasted 24 hours from sign-in. On a desk one person opens every
morning on their own phone, that was a password and an authenticator code every
day, and the code app taught nobody anything after the first week except to
keep it open. **A session now lasts seven days from sign-in**, still counted
from sign-in and not from the last visit — using the desk does not stretch it,
so a phone left signed in still asks again on a known day.

What a short session was really guarding against — a lost phone — is guarded
better by the account page: every device is listed with its address, when it
signed in, when it was last active and now **when its sign-in ends**, and one
button signs the others out. Changing the password still ends every other
session on the spot.

**What changed, and where.**

- `SESSION_MS` in `auth/service.ts` is `7 × 24 h`; the cookie's `Max-Age`
  follows it (604800). The code and setup steps are still 5 and 15 minutes.
- **DB:** no schema change. Each session row already carries its own
  `expires_at`, so the length is a property of the sign-in, not of the table.
  The sign-in you hold at the moment of deploy keeps the day it was issued with
  (its cookie in the browser has the old `Max-Age` too); the next sign-in gets
  the week. Nothing is extended behind anyone's back.
- **Pruning** counted "a week after sign-in", which with a week-long session
  would have deleted a row the moment it expired. It now counts a week after
  the session *ended* — expired or signed out — so "which devices were signed
  in" can still be answered for a while afterwards.
- **UI:** the sign-in page says a week; the device list shows `ends 21 Sep,
  09:30`; and `ago()` has a days tier, because "143h ago" is a sum, not a time.
- Docs: DEPLOY.md and SECURITY-AUDIT.md say a week.

**Tests** (auth-flow, 28 passing): the cookie carries `Max-Age=604800`; a
session answers a minute before the week is up and refuses just after; daily
use for seven days does not stretch it; the account page reports the end a
week out; an ended row survives six days after logging out and is gone after
seven, while a row that expired later stays a little longer.

- [ ] If a week ever feels long, the right next step is not a shorter session
  but a **fresh-code requirement on the actions that matter** (going live,
  changing limits) — the password change already works that way.

## The account's total, the day's move, and the tab

*14 September 2026*

Three small things asked for from the screen, each with a reason.

**Total.** The account card led with Available and Used, and the sum -- what
the account is worth altogether, Delta's "Wallet Balance" -- had to be added in
the head. It is now the first row, in bold. The used part is an estimate from
each trade's leverage (Delta reports free margin, not used), so the total
carries the same caveat and shows a dash rather than a wrong number when the
estimate cannot be made. Three tests.

**"+88 pts this session".** The header's move was measured inside the front
contract, and by evening the front contract is *tomorrow's* -- not open yet, so
the figure vanished and the header fell back to "since you opened the page",
a baseline that meant nothing next to the day's P&L beside it. The move is now
measured from **05:30 IST today** all day, the same moment as every other
"today" on the desk: `hoursSinceDeskOpen` in `chain.ts`, the row labelled
`today, since 05:30` (`TODAY_MOVE`, one string shared by server and web), and
the sudden-move reading uses the same span. Two tests on the clock arithmetic,
including 19:33 IST reading 14.05 hours in.

**The tab.** `78,397 +88 · +₹4,354 · BTC Desk` -- price, day move, day P&L --
so a glance at the tab from another one answers the question. The move goes in
only once it is the day's, the P&L only once the server has answered, and a
signed-out page says nothing but the name. `lib/tab-title.ts`, four tests.

## Zoom you can find, on a phone you can read

*14 September 2026*

"Zoom is not user friendly, and on a phone it is not responsive." Both true.

**Not friendly:** the only way in was the wheel, and the wheel only worked after
a chip called *Zoom off* had been found and turned on. Now **+ and − are always
in the header and always work**, armed or not -- they zoom about the newest
bar, which is the one bar anyone pressing + wants closer (and about the middle
once the window has been panned into history, where "newest on screen" is
nothing in particular). *Fit* is always there too, greyed out when there is
nothing to fit. The chip still governs the *gestures*, because those fight the
page: on, the wheel zooms, a drag pans, a **pinch zooms about the fingers**, a
**drag on the price axis stretches the scale** (down is out, up is in, a
hundred pixels an e-fold -- the height of a phone's plot reaches the walls),
and a **double-tap** puts it back where a phone has no double-click. A lifted
finger ends every gesture, so the finger left behind after a pinch does not
drag the window somewhere new on its way out.

**Not responsive:** the canvas was a fixed 780×360 viewBox scaled to fit,
which on a 360-pixel phone drew every label at under five pixels and every
wick as a hair -- responsive in the sense of fitting, unreadable in every
other. **The canvas is now drawn at the width it is shown** (a `ResizeObserver`
on the card, padding taken off) and the height follows the width, so text is
text-sized on every screen. Under jsdom the observer is a stub and the chart
draws at the old 780, so every geometry test still pins what it pinned.

Also: the tools take a row of their own under the title on a phone instead of
wrapping wherever the width ran out, and on a touch screen every chip grows to
32px with the +/− at least 36 wide.

**Tests** (PriceChart, 43): the buttons work with zoom off and stop at both
ends; + keeps the newest bar on screen; a pinch halves the bars when the
fingers double their distance and returns the window when they return; two
fingers on an armed chart pinch it through the DOM and the finger left behind
moves nothing; one finger pans and does not scroll the page; the axis drag's
arithmetic and, through the DOM, that a drag down brings a wall onto the
scale; two taps fit; with zoom off a finger is left to the page; and a
360-wide card draws a 360-wide canvas with the newest bar still clear of the
axis.

- [ ] Not looked at on a real phone yet -- the desk needs a password and an
  authenticator code, so the headless check could not sign in. Worth one
  glance at the tools row at 360px.

## A second server

*14 September 2026*

Asked for: an md to copy the project to another server with `git pull`.
[NEW-SERVER.md](NEW-SERVER.md) is that -- machine, Docker, Node 24, deploy
key, `.env`, which databases to copy and how (a SQLite backup for `chain.db`,
the API stopped first for `trades.db`/`auth.db`), deploy, refresh, cron,
HTTPS with Caddy, first sign-in, checklist.

The part that is not a command: **never two live desks on one Delta account.**
Each desk is a whole engine, and two of them would both sell the morning
strategy and reconcile each other's orders away. The guide opens with that
decision and the `.env` for each answer.

"How do I give the DB to that server?" -- two scripts, so it is not five
steps with a WAL trap in the middle. `deploy/export-data.sh` snapshots
`chain.db`, `trades.db` and `auth.db` out of the Docker volume with SQLite's
backup API (through a throwaway `python:3-alpine`, because the volume's
directory is root-only on the host and the API's filesystem is read-only)
into one tarball, desk still running; `deploy/import-data.sh <tarball>` on
the other side stops the API, swaps the files in with their journals removed
and the right owner, seeds `chain.db` at the repo root for `refresh.sh`,
starts the API and waits for health. Tried here: export from the live volume
(735 days, 58 trades), import into a scratch volume, every file opens.
`.env` is deliberately not in the tarball.

One small change alongside it: `WEB_BIND` in `docker-compose.yml` and
`deploy.sh`, so a host with its own reverse proxy can publish the web port on
`127.0.0.1` -- a port Docker publishes on `0.0.0.0` is open to the internet
whatever ufw says, because Docker's iptables rules run ahead of ufw's. The
default is unchanged, so this host deploys as before.

- [ ] The current host's cron runs `refresh.sh` at `40 12` under
  `CRON_TZ=Asia/Kolkata` -- 12:40 IST, *before* the 17:30 settlement. The
  guide says 12:40 UTC (18:10 IST). Worth checking which the harvester
  actually wants; if the current line is harvesting a day that has not
  settled, "today" in the record may be a partial day until the next run.

## Closing some of it

*15 September 2026*

"Close now" bought back the whole position, every time. The only way to take
half off was Delta's own screen -- which leaves the desk's record and the
exchange disagreeing until something reconciles them, the same gap that lost a
100-lot fill on 14 September.

**The sheet now asks how many, and opens on the whole position.** So the old
behaviour is the default and costs nothing -- open, swipe, done -- and a
smaller number is one tap (*Half*) or one keystroke away. Everything on the
sheet moves with that number: the title line, what is left behind, and the
money.

**What happens underneath a close of part of a position.** Both legs of
protection come off, the size is bought back reduce-only at the market, and
the next poll puts a target and a stop back over what is left, sized to it.
Leaving the stop resting and resizing it afterwards would have been fewer
orders and a worse idea: a stop for 1,500 and a reduce-only buy for 500 are
two orders closing one position, and Delta will fill both. The cancel-close-
re-protect path is the one the desk already trusts after every add.

**The state machine had to be told the difference.** An exit fill that leaves
a position behind used to mean one thing: a close that filled half way, still
working, `exit_pending` -- where the desk deliberately does not re-protect. A
close asked for *by size* is the opposite: it has done its job, and the rest
is a position again. So `exit_submitted` now carries what the close asked for
(`size`, `heldBefore`, `all`), the state carries it while it works, and the
moment enough is bought back the trade goes to `position_open` with
`exitWinner` left null -- nothing raced, so there is no loser to cancel.

- **DB:** no migration. The journal is JSON: an `exit_submitted` written before
  this carries no `closing` and replays as "all of it", which is what those
  closes were. `position_open` was already an open phase.
- **Overshooting is impossible.** A size larger than what is held closes what
  is held -- the position is re-read from the exchange a moment before sending
  -- and nothing is ever sold to make up a difference. The sheet refuses more
  than it shows; the engine refuses it again against the live number.
- **The money is the server's.** `trading/close-preview.ts` prices *this close*
  -- what it books, Delta's charges to buy those contracts back, the two netted
  -- at the ask, because closing a short is a buy. Not the trade's history: "this
  close books ₹4,300" is the question someone closing 500 of 1,500 is asking.
- **Telegram** says `PART CLOSED AT MARKET … the rest stays on, with its target
  and stop put back over it`, rather than "exit working", which would have said
  the position was on its way out when it is not.

**Tests.** 25 new server tests (`test/trading/close-part.test.ts`): a close with
no size behaves exactly as it always did; a size buys back exactly that many
and leaves the rest short; what is left gets protection sized to it; cancels
come before the close is sent; the part is booked and the rest stays open;
closing the rest goes flat; one contract at a time; a size bigger than the
position; a position that has already gone; zero, fractions, and an exchange
that refuses; the journal carries the size and replays to the same place. Plus
the preview's arithmetic and the body parser. Web: 9 new tests on the sheet --
opens on the whole position, a smaller size sends that size, Half and All, the
money following the number from the server, both refusals, an emptied box
meaning everything again, "replaced" rather than "cancelled" when part is left,
and a fill landing mid-typing not overwriting what is being typed.

## The wall the strategy could not see

*16 September 2026*

`TESTING OI` ran at 05:40 and sold `CE 80000 x10 @ 1, PE 74400 x10 @ 54`, and
the desk's own Market Insights card said the walls were **81,600** and
**73,600**. Two screens, one board, two answers.

**Neither was wrong about what it could see.** `liveChain(width)` keeps `width`
strike steps either side of the money and throws the rest away. The strategy
runner took the default, 25 — at $200 steps around 75,805 that is a board
running 70,800 to 80,800. The call wall sat at **81,600 with 394,748 open**,
past the edge, so the rule picked the heaviest strike inside the window and
that was 80,000. The desk card was drawn from a chain fetched at whatever width
the browser's own setting asked for, which is why the two disagreed, and why
the disagreement moved when the table width was changed.

`width` is a **display** setting: how many rows the chain table should show.
Where open interest sits is a fact about the expiry. Anything that decides
something now reads the whole board (`WHOLE_BOARD`); the chain route still
trims `legs` to the requested width on the way out, so the table is unchanged
and the walls, max pain, PCR and the strategy all read every listed strike.

**Doubling is global now.** The second half of the same morning: the desk
refused `CE 80000` — *"pays 2.00 and the desk will not sell below 5.00"* — and
the put went on alone at ten lots. `doubleWhenOneSided` existed for exactly
that day and did nothing, because it required the probability gate: it was
measured on the gate's refusals (+36% on the record for no more drawdown) and
written as if the gate were the only thing that could refuse a leg. It is not.
No strike the rule can take, a sell score under the bar, or the trading gate
turning the order down for premium, spread or margin all leave the same
one-sided day.

So the setting now means what its label says — *if one leg does not go, sell
double on the one that does* — whatever refused it, and it no longer needs the
gate on. Which required one more change: the desk is asked about **both** legs
before either order is sent (`previewOpen`, the same gate `open` runs, nothing
sent), because a refusal that arrives after the first order is on the book
arrives too late to size the second. Only when doubling is on and both legs
were selected; otherwise the run sends exactly what it always sent.

Also: the strategy list row read `CE + PE · at least $15 · …` for a strategy
selling at the wall — `summarise()` called `describePremium` whatever
`strikeRule` said. The one line a strategy is checked by was describing a rule
it was not running.

**Tests.** `test/strategy/oi-wall-board.test.ts` rebuilds that morning's board
with Delta's own open interest: the 25-step window hides the call wall and
picks 80,000; the whole board picks 81,600 and 73,600; the put side was inside
the window all along, so a fix that only looked at the side that failed would
have looked right. Then the doubling decision, pure: the desk refusing either
leg doubles the other, doubling off leaves it at its own size and still reports
the refusal, both taken are left alone, both refused sells nothing, and a
one-legged strategy is never doubled by a refusal it never had. Server 817,
web 614.

- [ ] **Chain table: move the columns, and remember where they were put.**
  Drag a column header to reorder, saved per browser (the chain already keeps
  its other preferences in `localStorage` under `btc-desk:`). Worth doing with
  the same rule as the zoom toggle: the arrangement somebody chose is the one
  they get back, and a reset puts the tested order back. Not started.

## An add that waits an hour, and can be stopped

*16 September 2026*

An add by hand worked for **five minutes** — a default nobody chose and the
sheet never showed. Five minutes is long enough for the chase and nothing
else, and the whole point of adding by hand is *sell more of this if the price
comes back to me*, which is a question about the next hour, not the next
three hundred seconds.

- **An hour by default**, set on the sheet: a box in minutes with `15m / 1h /
  4h` beside it, four hours the ceiling the server already enforced. The line
  under it says what happens when it runs out, in the words of the number that
  was picked: *"Rests until it fills or 1h passes, then whatever is left is
  cancelled."*
- **Stop add**, on the position card, beside a countdown. An hour-long order
  with no clock next to it stops meaning anything ten minutes in, and the only
  way to be rid of one was to wait it out or close the whole position. It runs
  the same path the window's own expiry runs — cancel, count what filled, close
  the add out — so a person stopping an add and the clock stopping one leave
  the same record. Whatever already filled stays: an add half filled is part of
  the position, not an add undone.
- `POST /api/trade/add/cancel`, idempotent: an add that has just filled or just
  timed out is not an error to have asked about.

Tests: the hour is the default and a shorter window still goes; the window is
sent with the add and with the preview; the chips fill it in; past four hours,
zero and empty are all refused and send nothing. On the engine: a stopped add
keeps what it sold, the target and stop end up covering what is actually held,
stopping one that sold nothing changes nothing, stopping when nothing is adding
is not an error, and a stopped add does not come back on the next poll.

## Three small things on the screens

*16 September 2026*

**The P&L range is one control.** Two `<input type="date">` boxes, which render
as a picker in Chrome, a wheel on a phone and a bare text box in Firefox on
Linux — and ask for a range as two questions that can contradict each other
while they are being answered. It is the `DateRangePicker` the orders screen
already uses: both ends at once, its own presets, and it never hands over half
a range. The `7d / 30d / 90d / 1y` chips stay, and now light up when the range
showing is theirs. The reversed-range guard stays too — unreachable through the
control, but the dates are remembered in the browser and an old value there is
exactly how `from=2027&to=2026` reaches a fetch.

**The charges line says what is left.** *"₹63.89 paid · ₹29.77 to close"* was
two numbers going out and nothing coming back; the answer to the question it
raises — so what do I actually keep? — was in a panel above it under a
different name. The line now ends *"· close now → keep ₹733"*, or *lose* when
it is the other way. The same figure as *If closed now*, deliberately: this is
where the charges are, so this is where the number that has already had them
taken off belongs.

**The resting exits say what they are worth.** The card said `Target 0.80` and
left the arithmetic to the reader: 0.80 against an average of 13.00 over 1,400
contracts, less what Delta takes. The ticket has always shown that number while
the bar is being dragged — *"buys back at 0.80 · you keep ₹1,452"* — and
stopped showing it the moment the order was resting, which is when it is worth
most. Now: `Target 0.80 → keep ₹1,447`, `Stop 26.00 → lose ₹1,564`.

All three figures on the card — *if closed now*, the target, the stop — are one
arithmetic (`netIfClosedAt`, in `close-preview.ts`) under three prices, so they
cannot tell different stories about the same position; a test pins that closing
at the mark and a target at the mark give the same number. Priced after every
charge, and absent rather than zero when there is no price, no position or no
entry average to work from.

## Moving the columns

*16 September 2026*

Which column sits next to the strike is the one real layout decision on the
board — it is the column the eye lands on — and it was fixed in a source file.
The picker could turn a column off; it could not move it.

Now it can, three ways, all ending in the same pure `moveColumn`: **drag a
row**, **press the arrows** beside it, or **hold it with the keyboard** (Space,
then ↑/↓). Drag alone would have been the obvious build and the wrong one: it
does not work from a keyboard, and on a touch screen a drag inside a scrolling
list fights the scroll — so the arrows are what a thumb uses, and they grow on
a coarse pointer.

The order is the calls side read outward; the puts side is the mirror of it, as
it always was. Header and cells both come from one list (`columnsInOrder`), so
they cannot draw one column under another's heading, and the existing test that
the group header's `colSpan` equals the cells in a row now runs over a
rearranged board too.

**Remembered in `localStorage`** (`btc-desk:chain:column-order`), beside the
on/off choices — not `sessionStorage`: a board somebody arranged is a
preference, and having to arrange it again in every new tab is the same as not
saving it. Reset puts both back.

The stored order is normalised before anything is drawn from it: unknown keys
dropped, repeats kept once, and **any column this build has that the stored
order does not is appended in its declared place**. That last rule is the one
that matters — without it, the release that adds a column makes it invisible to
everyone who has ever touched this panel.

**Tests** (24 on the picker, 6 on the table): the list draws in the order given;
the arrows move one row and hand back the whole order; the ends are disabled; a
drag from one row to another rearranges; a drop on itself moves nothing; Space
then ↑ moves without a mouse and the arrows do nothing until the row is held;
the handle says where the row sits; Reset restores arrangement and choices; with
no handler the panel is the chooser it always was. On the board: the order is
honoured, the puts side stays the mirror, the cells move with their headings, a
hidden column takes its place with it, and the spans still match.

## Is there a side today?

*16 September 2026*

The desk showed five windows — 24h +0.25%, 12h −0.13%, 6h −0.15%, 1h −0.16%,
15m +0.27% — and left the adding-up to somebody at half past five in the
morning. Five facts are not a decision.

**`domain/direction.ts`** does the adding up: seven inputs across five
timeframes, each normalised to −1…+1, weighted, and damped by the strongest
ADX on the board, because agreement in a market going nowhere is agreement
about noise. Past ±0.45 it names a side. Then five gates — direction,
timeframe hierarchy, strikes clear of the expected move, option structure,
execution and hedge — four of which must pass before a side is *confirmed*. A
gate with nothing to read is never a pass, the same rule the sudden-move gate
follows.

**It decides nothing.** The lots are still split by the tested 2% / 70-30 rule,
which has 733 days behind it. This is the reading done before trusting that
split, and the first test written was the one that matters: **the 16 September
board returns no side.**

Three new indicators feed it, computed per timeframe in `moves.ts`: Wilder's
**ADX(14)**, session **VWAP** and the distance to it, **RSI slope** (the level
says where momentum is, the slope says which way it is going), and **fractal
swing structure** (higher highs *and* higher lows). Cumulative delta and
funding are deliberately absent — the desk fetches neither the aggressor side
of trades nor the perpetual, and a number that looks like order flow and is not
would be worse than the gap.

Also landed from the same research:

- **EM× on the board** — `|K − S| ÷ expected move`. "1,400 away" is a long way
  on a quiet day and inside the noise on a violent one; "1.88 expected moves"
  is the same statement on every day. Under 1.0 is marked.
- **Containment** — `P(low < S_T < high) = N(d₂ low) − N(d₂ high)`, the number a
  two-sided seller is actually betting on. Not the two one-sided probabilities
  multiplied: they are two views of one distribution.
- Confirmed by test that **T is real remaining time** everywhere, and that
  touch and near-zero probabilities already exist in `probability.ts` (they are
  computed per strike; only the expiry one is on the board so far).

**19 tests** on the score, the gates and the corridor; 10 on the card.

## A late-entry window per strategy

*16 September 2026*

`GRACE_MIN = 60` was one constant for the whole desk, and invisible — a
strategy that quietly did not run at 07:00 looked broken rather than late. How
long "still fine" lasts belongs to the strategy: an hour into a twelve-hour
contract is nothing, ten minutes into a signal is everything.

`config.graceMin`, default 60, on the **When** tab with `5m / 15m / 1h / 4h`
chips and a sentence that reads back the number: *"Up to 60 minutes after 5:30
AM the desk still takes the entry."* Validated 1–240 both sides. **No
migration:** the config is JSON, and a strategy saved before the setting existed
reads as the old constant.

## What the Live tab actually computes

*16 September 2026*

[LIVE-TAB-AND-CHAIN.md](LIVE-TAB-AND-CHAIN.md) — every figure on the Live tab
and the chain, with its formula, inputs, thresholds and what the record says
about it. Written to be read beside the screen so a number that looks wrong can
be traced without opening the code, and ending with the research list: what is
measured and trusted, what is shown and deliberately not wired into anything,
and the gaps.

**The gaps it names**, all still open:

- [ ] **Stress scenarios** per proposed trade: P&L and margin at BTC ±1/2/3%
  and IV ±5 points. Max loss says what happens at the end, not on the way.
- [ ] **Credit ÷ risk** and **premium ÷ distance** as ranking columns. The
  board ranks by score and EV; neither says what the premium costs in risk.
- [x] **Touch and near-zero as their own columns.** Done 16 Sep — see *Where it
  finishes, and what it does on the way*.
- [ ] **Calibration outside 8–16 hours to expiry**, so a next-day expiry is
  scored rather than caveated.
- [ ] **Hedge availability in the gates before the strike is chosen.**
- [ ] **The direction score's weights have never been backtested.** Written
  down in one place so they can be measured; until they are, the card decides
  nothing.

## Room on the Live tab

*16 September 2026*

The two-column board split at 1,060px into 32% — 339 pixels — and the settings
bar, the side verdict and the insight tiles all lived in the narrow one. Once
the verdict card arrived, that column ran several hundred pixels past the
chart and left a hole beside it the height of a screen: a two-column layout
where one column simply stops.

- The split now waits for **1,180px**, the narrow column has a **360px floor**,
  and it widens to 400 past 1,500 rather than staying a fixed third of an
  ever-wider page.
- **Market Insights moved under the chart**, into the wide column. It fills the
  hole, and the tiles get to be a real grid instead of two squeezed columns.
- The column picker is 380px wide (it now carries handles and arrows), the add
  and close sheets wrap their chip rows, and the verdict card stacks its bars
  under the labels below 380px.

- [ ] **Not verified by eye.** The desk needs a password and an authenticator
  code, so a headless browser cannot reach it here — only the sign-in screen
  could be rendered, which has no horizontal overflow at 360–1920px. Worth one
  look at **390, 768, 1180 and 1440** to confirm the hole is gone and nothing
  new is cramped.

## Where it finishes, and what it does on the way

*16 September 2026*

`P(expires worthless)` and `P(touches the strike)` are different questions, and
the board only drew the first. On the 16 September put — spot 75,820, short at
74,400, twelve hours, 30% vol — they are **96.9%** and **24%**, and reading only
the first makes the trade look quieter than it is lived.

They are not two chances of losing. A path of 75,820 → 74,400 → 75,600 touches
**and** settles worthless; touch is the drawdown and the margin pressure to sit
through. So the desk draws it, marks it when it is high (25% amber, 50% red),
and **refuses nothing for it** — no gate reads it, and the sheet says so in
words.

- **Two new columns**: `Touch` (on by default — every other probability on the
  board is about where the day ends, and this is the only one about the middle)
  and `≈0`, the near-zero simulation (off by default: it is null for anything
  far out or already worth pennies, and a column of dots earns nothing).
- **One row in the strike sheet**: `Expiry OTM · Touch · Near-zero · EM× · At
  ±1 EM`, which is the arrangement asked for. The fifth is the stress test in
  miniature and the only one in money: BTC travels exactly one expected move
  straight at this strike and settles there — *nothing* for a strike a move
  cannot reach, `$3.58 a contract` for one it can.

**The formula is now pinned by a test**, not just documented:

```
b = ln(K/S)   mu = -sigma^2/2   sig = sigma*sqrt(T)
P = N((-b + mu*T)/sig) + exp(2*mu*b/sigma^2) * N((-b - mu*T)/sig)
```

`probability.test.ts` recomputes it by hand with its own error function and
requires agreement to 1e-9 at four strikes, plus the properties that hold
whatever the implementation: certain at the money, nothing far out, rising with
time and with volatility, and never below the chance of finishing beyond the
strike. The worked example above is a test too.

[LIVE-TAB-AND-CHAIN.md](LIVE-TAB-AND-CHAIN.md) §2 carries the same worked
example, the path that touches and still settles worthless, the A/B comparison
(97%/12% against 98%/31%), and what touch does *not* say: when it happens, how
deep it goes, or anything at all if the volatility estimate is wrong.

## One trade, and where the next few hours could go

*16 September 2026*

Two cards, from the research notes, and one line that decides how both are
written:

> Prediction, options risk and trade eligibility are three questions. Keeping
> them apart is the architecture; mixing them into one score is how "the market
> looks bullish" becomes "sell this put".

**Best trade · this expiry** replaces *Best expected value*, which ranked on one
number and could not say what the trade costs when it goes wrong. It names one
order — `SELL PE 75,400` — with the premium, the settlement odds, touch,
near-zero, EM×, delta, credit, max loss with the hedge that caps it, credit ÷
risk, and a liquidity score. Ranked 0.35 credit-against-risk, 0.30 settlement
odds, 0.20 distance, 0.15 liquidity, all declared in `BEST_TRADE_WEIGHTS`.

- **Touch does not vote.** It is on the card and out of the ranking: a touch is
  a drawdown, not a loss, and ranking on it would refuse the strike that pays
  for exactly the risk a seller is in business to take. A test pins that two
  strikes differing only in touch rank identically.
- **Max loss needs a hedge to be a number.** Without one the card says
  *uncapped* rather than printing something, and credit ÷ risk is a dash.
- **The hedge now counts listed strikes**, not dollar steps — Delta lists $200
  apart near the money and $400 further out, so "three out" and "3 × 200" are
  different contracts as soon as the grid widens, and the second is often not
  listed. That was a real bug: it read as "no hedge available" on boards that
  had one.
- **The morning nothing clears**: the hard rules are strict (3% OTM, 95%
  calibrated, delta under 0.05, a tenth of open interest traded, spread inside
  10%, a print in the last half hour) and on a quiet board nothing passes all
  six. Rather than an empty card, the board is ranked anyway, the badge says
  *Nothing clears*, and the pick carries the rules it is failing.

**What the next few hours could do** — its own row across the page, a card per
horizon: 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 24h and settlement. Each carries the
band the option market is charging for (`spot × IV × √(t/365d)`), what BTC
actually did over that horizon in 105,119 measured windows, and **Below / Inside
/ Above** that band from the measured distribution. *Inside* above 68% is the
market paying for more move than it usually gets, which is the seller's whole
business said per horizon.

**There is no "DOWN 52%" on it, and there will not be.** The desk measured
direction over those windows: 49.4% up at five minutes, 50.6% at twelve hours,
never outside 48–52% at any horizon. The arrow is a *score* from that
timeframe's EMAs, RSI, structure and VWAP, labelled as one, and only for the
horizons the desk fetches bars for — 30m, 2h, 6h and 12h say *not read* rather
than drawing a flat arrow that looks considered. The formulas are one tap away
on the card itself.

**Tests**: 18 on the pick (eligibility absolute, touch not voting, the money
from the real hedge, the fallback and its failures, the liquidity parts), 17 on
the horizons (the band is √t, implied against measured, nothing invented where
there are no bars, the consensus renormalised), 14 and 11 on the two cards.

[LIVE-TAB-AND-CHAIN.md](LIVE-TAB-AND-CHAIN.md) has both as §7b and §7c, with
the weights and the formulas.

## Alerts, with a switch

*16 September 2026*

Fill alerts were on whenever `TG_TOKEN` was set and off otherwise, and changing
that meant editing `.env` and restarting the desk. Now there is a switch in the
header beside the mode switch.

Two facts kept apart, deliberately: whether Telegram is **configured** (a token
on the server — a deployment question) and whether messages are **wanted right
now** (a preference). With no token there is no switch, only a greyed bell
saying which variables to set: a control that cannot do anything is worse than
no control.

- Remembered in the journal (`alerts_enabled`), not in the browser — a silence
  chosen on a quiet afternoon survives a deploy and is not undone by opening
  the desk on another phone.
- **It silences messages, not the desk.** The engine never reads it: positions
  open, protect and close exactly as before. The title says so in as many
  words, because a bell in a trading header looks like it might turn off
  something that matters.
- Both paths honour it — fill alerts from the trading service and the
  strategy runner's own run alerts.

Eight tests, including that a server predating the switch reads as configured-off
rather than as broken, and that a refusal says *Try again* rather than pretending
it worked.

## The row that said the same thing nine times

*16 September 2026*

Checked against the drawing it came from, and two things did not match — both
mine, both real:

**Ten identical prices.** Every card showed spot: 75,803, nine times over. The
drawing shows a projected price per horizon, and there is no honest one to put
there — the measured drift over these horizons is nil, so any projection is spot
with extra steps. Fixed the other way: **spot is written once above the row**,
and each card carries only its own band. The panel now says what it knows
instead of repeating what it does not.

**Below / Inside / Above said the same thing on every card** — 16 / 69 / 15, nine
times. Not a rendering fault: both the implied band and the measured one scale
with `√t`, so their ratio is near-constant *by construction*. Measured: 68.1%
inside at five minutes, 68.5% at an hour, 63.3% at twelve. Three figures that
cannot vary are three figures nobody should read.

What does vary is the two bands against each other, and it is also the only
question a seller is asking:

| horizon | implied | history | ratio |
|---|---|---|---|
| 5m | 0.093% | 0.092% | 1.00 |
| 1h | 0.321% | 0.316% | 1.01 |
| 4h | 0.641% | 0.649% | 0.99 |
| 12h | 1.110% | 1.257% | **0.88** |
| 24h | 1.570% | 1.778% | **0.88** |

So each card now **leads with `0.88× history · market pays less`**, and the
three shares stay underneath as the working. Fairly priced out to four hours,
paying noticeably less than history delivers at the long end — which is a
statement about today's board, and the sort of thing the row exists to make
visible.

Also: the settlement card no longer spans two columns (it orphaned itself onto
its own row the moment ten cards did not fit across), and the best-trade badge
reads **Recommended** only when the pick clears every hard rule *and* the tested
engine picked it too — the one combination on that card that deserves the word.

Three new server tests on the ratio, two on the card.

## The screen that was polling itself to a standstill

*17 September 2026*

"UI is slow, something is looping." It was not a loop. Fifteen minutes of the
API log: **`/api/trade/status` — 355 calls, averaging 994ms, worst 3.3s** —
polled once a second by every open tab. Each call fanned out to Delta for the
balance (uncached), the positions, and a quote and the book per open symbol,
behind per-read caches of 800ms. A request that took a second to answer missed
every cache, and two tabs meant two fan-outs. The poll was saturating its own
server, and the screen was always waiting on the last answer.

Two changes, both in `service.ts`:

- **`coalesce(key, ttl, compute)`** — one computation at a time, shared by
  everyone who asks while it runs, kept for the TTL after. The status route
  is now computed at most once per 900ms however many tabs poll, and a poll
  arriving mid-computation waits for that answer rather than starting another.
  Aged from when the read *started*, not when it returned: a slow answer is
  already old by the time it arrives.
- **`balanceForDisplay()`** — the balance cached two seconds for the account
  card. `balance()` stays a real read for the gates.

Three tests: three callers share one computation and one answer; a fresh one
runs past the window and a failure does not poison the cache; keys do not
share. Not a longer cache — a shared one.

## A reminder on the best pick, and one place for each fact

*17 September 2026*

**"Tell me when the best pick changes."** On the best-pick card, a switch —
not a price to type. The first version asked for a price and rang when a
strike paid it; that was the wrong question, and it was taken out the same
day. What the card knows is *which strike is the pick*, and that is the thing
worth a message: once, when it becomes a different strike, never while it
stays the same one. `watchBestTrade` reads the whole board once a minute,
works the pick out **the same way the card does** (`bestTradeNow`, one
function for both, so the phone and the screen cannot name different
strikes), and compares it with the last one announced in the journal
(`best_trade_last`). Off by default; switching it on announces the current
pick rather than waiting for a change; the header's phone-alerts switch still
silences it. The message is the whole card — the reader has not seen these
numbers.

**Only strikes paying $5 or more.** A floor on the pick itself, default $5,
adjustable on the card and remembered on the server (`best_trade_min_premium`,
0 < floor ≤ 1000). A $1.50 strike with a 99.5% chance of expiring worthless
used to win the ranking on settlement alone; it is not a trade anybody
places. The floor is an eligibility rule like the others — a strike under it
is shown with the reason, and the fallback ranking still names the nearest
miss when nothing clears. The engine's own $15 floor is untouched; this is
the card's, and the card decides nothing.

Migration `009-premium-alerts` stays in the ledger with a note that nothing
reads the table: a migration that ran is a fact, and un-running it is how
two servers end up disagreeing about what 010 is. Eleven server tests on the
watcher (silence on the same pick, a pick that goes away and comes back, the
floor deciding, phone-alerts-off remembering without sending) and seven on
the control.

**Each fact once.** The Live tab said the spot four times, the implied
volatility three times, the expected move three times, and direction twice.
Now:

- *Which way is the market leaning?* sits at the head of the horizon row it is
  drawn from, with its seven inputs and five checks behind a toggle. One card
  about direction, not two.
- *Market insights* folded into the sudden-move card as its "key market data",
  minus the three tiles that card already leads with.
- The *Market* card lost its volatility and expected-move blocks; their
  working moved into the hover on the numbers up top. What stays is what is
  about this contract and nowhere else.

**Plain English**, on every card that arrived this week: *Chance you keep it
all* for "Expiry OTM", *Chance price gets there first* for "Touch", *Most you
can lose (with the safety leg)* for "Max loss (with hedge)", *How easy to
trade* for "Liquidity", *Ends lower / in range / higher* for "Below / Inside /
Above", *Leaning up / No clear lean* for "Bullish / No side", *options cost
more than usual* for "rich". The technical term is still there, in the hover
hint, so nothing is untraceable — but the label is the sentence a person
would say.


## Delta off the request path

*17 September 2026*

Coalescing the status route (above) made two tabs one fan-out; it did not
make the fan-out fast. The deployed image still showed **`/api/trade/status`
averaging 853ms**, because every poll that missed the 900ms window waited on
Delta for the balance, the positions and the books. The one-second poll was
always going to miss it.

So the server now refreshes the status **on its own clock**, and a request
reads the last answer at once:

- `provideStatus(compute)` — the route hands the service its status function
  once at startup; `refreshStatus()` runs it every second in the background
  (`STATUS_REFRESH_MS`), never overlapping.
- `status()` — returns the last answer if it is under four seconds old
  (`STATUS_STALE_MS`); an older one, or none yet, is recomputed on the request
  so a stalled refresher cannot serve the morning's balance all afternoon.
- The per-read caches under it (positions, quotes) went from 800ms to 1500ms
  — they are now refreshed by one caller on one clock, so a longer window
  costs nothing in staleness.
- `/api/spot` reads the ticker cache the desk already keeps warm instead of
  asking Delta again.

Tests: a request lands in under 15ms from memory; a stale answer is not
served; with nothing computed yet the first request computes and says so if
it cannot. Timers are cleared in `stop()`, with the best-pick watcher and the
mark-to-market pass.

**To check after the next deploy**: `docker logs btc-desk-api-1` for the
`/api/trade/status` timing line — it should read in milliseconds, not
hundreds. The image on the server as this was written (`7246ac8-dirty`)
predates it.

## Where the lag actually was

*17 September 2026*

With the status off the request path (above) the deployed log read
`/api/trade/status` 1.6ms, `/api/spot` 6ms — and the screen still stuttered.
Timed stage by stage inside the container, `/api/chain` at 377ms was **not
the network**: the tickers were cached, and 350ms of it was
`pReachNearZero` — 2,000 paths × 24 Black-Scholes repricings for every
strike worth selling — run again on every chain request, every strategy tick
and every best-pick check. Node has one thread. Every one-second poll that
landed during those 350ms waited behind it (`/api/spot` max 726ms in the same
log, against a 1ms median), and the screen felt it.

Two changes, neither touching a formula:

- **Server** — the simulated probabilities are kept **per ticker batch**
  (`probsByBatch`, a `WeakMap` keyed on the cached ticker array, so it dies
  with the batch). Spot, strike and volatility cannot change between two
  reads of one batch; the seconds of expiry that do change are below what
  the simulation can resolve. Same arithmetic, once per fetch instead of once
  per request. One test: two reads of one batch hand back the same
  probability objects, and the display window does not change them.
- **Web** — `App` renders once a second for the price and position polls,
  and every card under it rendered with it: seventy rows of chain, nine
  horizon cards, the chart, rebuilt each second to show a five-second-old
  board. The board's cards are now `memo`'d (`Board`, `OutlookRow`,
  `BestPick`, `Shock`, `Chart`) and every prop they take is stable between
  chain loads — `sides` and the column preferences memoised, `held` keyed on
  its content so a position list that says the same thing is the same prop,
  one empty `NO_BARS`, one `reload` callback. A card redraws when the board
  changes, not when the clock does.

Checked and left alone: the databases are small (the largest 4MB), on WAL
with a 5s busy timeout; the open-interest write is one indexed lookup then a
write every five minutes per expiry; the horizon reads are under 5ms. The
DB side was never the problem.

**The best-pick card, shorter.** Eleven figures in one column stood the
card at twice the height of the Market card beside it on a desk. From 600px
the figures sit in two columns; "chosen on" and "behind it" are one line;
the footnote is two sentences. Same figures, same words — half the height.
The CSS for the removed price-alert list went with it.

## Pushed, not polled

*17 September 2026*

Two feeds, each replaced by the thing that tells you when something changed.

**Delta → server: the ticker socket.** The board was a REST download every
eight seconds — every option ticker, whether or not anything had changed,
on average four seconds old. Delta publishes the same tickers on a public
socket (`wss://socket.india.delta.exchange`, channel `v2/ticker`) the moment
they change. `market/delta-socket.ts` subscribes, drops everything that is
not a BTC option before parsing it (a substring check; Delta sends ~250
tickers a second across every product), folds the rest into a map, and hands
the map on as a batch at most once a second and only if something changed.
That batch lands in exactly the place the REST poll wrote — `tickerCache`,
and the price — so `liveChain`, the strategy tick and the best-pick watcher
cannot tell the two apart. The REST poll stays as the cold start (the full
list is the truth about which contracts exist; the socket only ever hears
about ones that change) and the fallback: it runs only while the socket has
been silent for 20 seconds. A silent open socket is dropped and remade. No
key, no authentication — the desk's credentials never go near this socket
and it can place nothing. `/api/health` carries `feed.source`.

**The simulation, off the request path.** A board that moves once a second
would have re-run the near-zero simulation once a second, and the per-batch
cache from the morning would have been worth nothing. It is now kept per
contract with the inputs it was worked out from (spot to $25, volatility to
half a point, expiry to five minutes — all below the simulation's own ±1%
noise). A read whose inputs moved gets the kept figure *now* and queues the
fresh one, computed one contract per turn of the event loop between
requests. No request pays for the simulation twice; only the first sight of a
contract pays at all. The closed-form figures are still worked out fresh
every time. Five tests, including the one that matters: moved inputs hand
back the kept figure at once and the fresh one after.

**Server → page: `/api/stream`.** Server-Sent Events rather than a
WebSocket, on purpose. Everything on this desk flows one way — the server
tells, the page acts through ordinary POSTs that carry the session and the
origin check — so a two-way socket would be a second door needing its own
authentication and cross-origin rules. An EventSource is a GET with a cookie:
the gate in `app.ts` covers it unchanged, the browser reconnects on its own,
and it passes through nginx as HTTP (`X-Accel-Buffering: no`, plus an
explicit `/api/stream` location in the web container's config). One tick a
second, but a tick writes only what differs from the last one written
(`StreamHub.publish`); a tab that connects late gets the current picture at
once; a keep-alive event every 15 seconds. Timers run only while someone is
listening.

On the page, `useStream` earns `live` from frames and loses it to silence or
a browser error, and the one-second polls run only while it is not live — so
the screen never depends on the push to move. Where a poll and a frame both
answer, the newer wins: a poll run after a button press must not be
overwritten by a frame from a second earlier. The dot beside the price says
which way updates are arriving.

**First download, smaller.** The calendar library (17 KB gzipped, a sixth of
the first load) was in the entry bundle for a picker that appears only when
somebody chooses a past date. The IST helpers it shared a file with moved to
`lib/ist-moment.ts`; the picker is lazy.

Server 930 tests, web 711. Databases untouched: nothing here is stored.
