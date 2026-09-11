# Opposite-leg add — test cases

BTC Desk · Strategy · 11 Sep 2026 · **not deployed**

When one leg's target buys contracts back, the desk sells that many more of the
other leg — only while the other leg still pays enough and has not run away.
Below is every case where it adds, and every case where it doesn't, with the
test that proves each.

## The rule

```
CE target buys back N  →  PE bid ≥ $3  and  PE mark < 2 × PE sale  →  sell N more PE
```

The same with CE and PE swapped. $3, 2× and the latest time to add are set in
the strategy form. The N contracts are appended to the PE trade itself: one position, one blended
average, and the PE's same target price and stop, resized to cover all of it.

| Check | Result |
|---|---|
| Server tests | **563 / 563** pass · typecheck clean |
| Web tests | **353 / 353** pass · typecheck clean |
| Live Delta prices, paper orders | **6 / 6** |
| Status | **Off** — not deployed · setting off on every strategy |

---

## It adds when

Prices are $ per BTC, as Delta quotes them. One lot is 0.001 BTC.

| Result | Case | Example | Proof |
|---|---|---|---|
| ✅ Adds | The CE target buys back 425 and the PE bid is 7 | PE 425 sold @ 15 · bid 7.00 / ask 7.50 → 425 more sold @ 7 · PE now −850 @ 11.00 avg | `add.test` case 1 · `adder.test` "the CE target buys back 425 while the PE bid is 7" |
| ✅ Adds | The mirror: the PE target buys back, the CE still pays | CE bid 7.00 → sells more CE · live run: CE 78,200 bid 10.00 → 425 filled @ 10.00 | `add.test` case 2 · live run row 2 |
| ✅ Adds | "Or however many hit": the size is what the target actually bought back | target filled 200 then 3 → adds 203, not 425 · filled 200 then 225 → two adds, 200 and 225, PE ends at −850 | `add.test` "a target that bought back 203 adds 203" · `adder.test` "a target in pieces adds each piece once" |
| ✅ Adds | The bid is exactly the minimum — "equal or above" | bid 3.00 with minimum $3 → adds | `add.test` "exactly $3 is equal or above" · `StrategyForm.test` (example row $3.00 "adds") |
| ✅ Adds | The minimum is yours to set | bid 4.00: minimum $4 → adds · minimum $5 → no | `add.test` "the minimum is the setting, not a constant" · `StrategyForm.test` "typing $5 redraws the examples" |
| ✅ Adds | Just under double still adds | PE sold @ 15 · mark 29.90 → adds · mark 30.00 → no | `add.test` "just under double still adds; the line is the mark" |
| ✅ Adds | "Doubled" is measured against the morning sale, not a blended average | PE 425 @ 15 + 200 added @ 7 = 12.44 avg · mark 25.50 → adds (under 2 × 15 = 30) | `add.test` "doubled is against the morning's sale" |

---

## It does not add when

Each of these is written to the add journal with its reason, and Telegram sends
"NOT ADDED" with the same reason — except the last two rows, which never reach a
decision.

| Result | Case | Example | Proof |
|---|---|---|---|
| ⛔ No add | The other leg's bid is below the minimum | PE bid 2.00 with $3 minimum → "PE bid 2.00 is below $3.00" · live: P-BTC-75400 bid 2.40 | `add.test` case 3 · `adder.test` "PE bid 2.00: nothing is sold" · live run rows 3, 5 |
| ⛔ No add | A one-sided day — only the CE was sold (the doubled 850) | CE 850, no PE → "no PE leg today, nothing to add to" | `add.test` case 4 · `adder.test` "a one-sided double day" · live run row 6 |
| ⛔ No add | The other leg has doubled since its sale — a losing leg | PE sold @ 15, mark 30 → no · live: sold @ 6.90, mark 16.10 → no | `add.test` "the PE sold at 15 now at 30 has doubled" · `adder.test` "PE at 30" · live run row 4 |
| ⛔ No add | The multiple is yours to set too | 1.5× · PE sold @ 15, mark 22.50 → no | `add.test` "the multiple is a setting too" |
| ⛔ No add | The other leg is already closed, or closing | PE position 0 → "already closed" · PE exit pending → "exit pending, not adding" | `add.test` "the other leg already closed" · "the other leg closing" |
| ⛔ No add | A stop or a manual close bought back — not a target | CE stop fills 425 → nothing · CE closed by hand → nothing | `add.test` "a stop or a manual close is not a target" |
| ⛔ No add | The leg that was added to hits its own target — no ping-pong | PE (425 + 425 added) target buys back 850 → "the PE was itself added to today, so it does not add back" | `add.test` "no ping-pong" · `adder.test` "does not add back to the CE" |
| ⛔ No add | The target fill is more than 2 minutes old | desk restarted after the fill → "too long ago to add" — never sells into a market that has moved on | `add.test` "a target filled more than two minutes ago is not acted on" |
| ⛔ No add | After the strategy's latest time to add (set on screen, between entry and exit; 4:59 PM by default for a 5:29 PM exit) | latest 4:59 PM · target at 4:59 PM → adds · at 5:00 PM → no · latest set to 12:00 PM → 12:01 PM no | `add.test` "not after the latest time to add" · "the latest time to add is the setting" |
| ⛔ No add | The other leg has no target, or its bid is already at the target | PE target 4.00, bid 3.50 → "already at its 4.00 target" — the add would be bought straight back | `add.test` "no price to exit an add at" · "a bid already at the target" |
| ⛔ No add | The other "leg" is yesterday's contract | PE on a different expiry → not paired · "no PE leg today" | `add.test` "yesterday's leg on another expiry" |
| 🚫 Refused | A desk gate says no — short limit, margin, feed down, spread, depth, daily loss | short limit 500, add would make 850 → "ADD REFUSED" · nothing sent · PE unchanged | `add-to-position.test` "the gates still apply" · `adder.test` "the gates refusing the add" |
| 🚨 Failed | Sending the add throws | "socket hang up" → "ADD FAILED" · written as failed · not tried again | `adder.test` "an add that throws is written down as failed" |
| 🔕 Silent | The setting is off, or the strategy is disabled | nothing decided, nothing written, no message | `add.test` "switched off" · `adder.test` "switched off, or the strategy disarmed" |
| ⏳ Waits | No price for the other leg yet, or an add is already working on it | decides nothing and writes nothing; looks again on the next pass (the 2-minute rule still ends the wait) | `add.test` "no price for the other leg yet" · "an add already working" |

---

## After it adds

The add is an extra sell under the same PE trade. These hold whatever the
market does while it works.

| Result | Case | Example | Proof |
|---|---|---|---|
| ✅ Holds | One trade, one position, the same target and stop covering everything | −850 @ 11.00 · target buy 850 @ 0.70 · stop 850 @ 45 · exchange position −850 | `add-to-position.test` "an add appends to the same trade" |
| ✅ Holds | The target is unchanged: a resting buy that fills when the ask comes down to it | ask reaches 0.70 → all 850 bought back @ 0.70 · booked (11.00 − 0.70) × 850 × 0.001 = $8.76 | `add-to-position.test` "the target is still a resting buy at its own price" |
| ✅ Holds | Never sold below the minimum, however far the bid falls | bid drops to 2.00 while the add walks → it stops at 3.00 and sells nothing at 2 | `add-to-position.test` "never sold below its minimum" · checked by breaking it: the test fails |
| ✅ Holds | It ends: unfilled after 5 minutes, the rest is cancelled | nothing filled → position unchanged, no sell left on the book · 100 of 425 filled → keeps 100, target and stop cover 525 | `add-to-position.test` "does not fill in its window" · "half fills keeps what filled" |
| ✅ Holds | Close now, the stop watch and the exit time take the add off first | Close now while the add rests @ 7.50, then a buyer arrives @ 8 → position stays 0 · mark 46.50 over stop 45 → all 850 closed | `add-to-position.test` "Close now while an add is working" (checked by breaking it) · "the stop watch covers the added contracts" |
| ✅ Holds | Never twice for the same contracts | the target-fill nudge and the 20-second tick at once → one add · restart → no second add · journal refuses a second row | `adder.test` "still add once" · "a restart does not add" · `store.test` "one decision, however many times" |
| ✅ Holds | Trouble at Delta does not break the open trade | Delta rejects → PE stays protected · no answer → looked up, never re-sent, fills still counted · restart mid-add → finished from the journal | `add-to-position.test` "Delta refusing the add" · "no answer is looked for" · "a restart in the middle of an add" |
| 🚫 Refused | One add at a time, and never while the leg's own entry is still working | second add while the first works → "already working" · entry 200 of 425 still resting → "the entry is still working" | `add-to-position.test` "one add at a time" · "not while the entry is still working" |

---

## On live Delta prices

11 Sep 2026, 11:37 IST · expiry 110926 · BTC 77,258.6. Every quote came from
Delta India's public ticker at that moment. All orders went to the paper
exchange; nothing reached your account.

| Case | Other leg, live | Spread | Result | Check |
|---|---|---|---|---|
| CE 78,200 target hits · rule $3 / 2× | P-BTC-76200 · 16.00 / 18.00 | 11.8% | ✅ Adds — 425 filled @ 16.00 · −850 @ 17.00 · target 0.90 and stop 54 resized to 850 | pass |
| Mirror: PE 76,200 target hits | C-BTC-78200 · 10.00 / 10.50 | 4.9% | ✅ Adds — 425 filled @ 10.00 · −850 @ 10.25 · target 0.50 and stop 31.5 resized to 850 | pass |
| Minimum set $1 above the live bid | P-BTC-76200 · 15.00 / 17.00 | 12.5% | ⛔ No add — "PE bid 15.00 is below $18.00" | pass |
| PE doubled (sold @ 6.90) | P-BTC-76200 · mark 16.10 | 12.5% | ⛔ No add — "PE at 16.10 is 2x or more its 6.90 sale" | pass |
| A real far PE paying under $3 | P-BTC-75400 · 2.40 / 3.00 | 22.2% | ⛔ No add — "PE bid 2.40 is below $3.00" | pass |
| One-sided day, CE only | — | — | ⛔ No add — "no PE leg today, nothing to add to" | pass |

**How the first add walked the live book:**

```
0.0s 18.00 → 1.3s 17.50 → 2.5s 17.00 → 3.8s 16.50 → 5.8s filled 425 @ 16.00
```

The strategy's own entry walk: start at the offer, step to the bid over 5
seconds, because the spread (11.8%) was inside the 15% limit.

> ⚠️ A first live run a few minutes earlier found the PE at 11 bid / 13 offered —
> a 16.7% spread. The add stopped at the middle price, 12.00, and was still
> resting 45 seconds later. That is the spread rule protecting you, and it means
> a wide-spread day adds less than the rule's numbers suggest.

> ℹ️ What was simulated: both legs were opened on paper at their live offer, and
> the target leg's target was made to fill. Each row was checked for the right
> reason, not only add or no add — an earlier version of the check passed two
> rows for the wrong reason and was fixed. Paper also fills a resting sell in
> full once the bid reaches it; Delta fills only what the bid size allows.

---

## What Telegram says

Examples written from the tested message formats, using the 11 September PE;
the refusal wording is the desk's real short-limit message. The ADDED message
only goes out when contracts actually fill.

```
➕ ADDED · BTC 74,000 PE
Expiry 11 Sep

Sold 425 more of 425 @ 7.0
Premium collected: ₹253 ($2.98)
Because the CE target bought back 425

Now short 850 @ 11.0 avg — target and stop cover all of it
🎯 Target 0.7   ⚠️ No stop-loss
09:08 IST · strategy · LIVE
```

```
ℹ️ NOT ADDED · CE+PE add

CE target bought back 425 — PE bid 2.00 is below $3.00
Nothing was sold.
09:08 IST · auto-trading · LIVE
```

```
⚠️ ADD REFUSED · CE+PE add

CE target bought back 425 — adding 425 to the PE 74000 at bid 7.00+, target 0.70 — refused: Would take total short to 1275, limit is 1240.
The checks turned the add down, so nothing was sold. The positions already open are unchanged.
09:08 IST · auto-trading · LIVE
```

```
ℹ️ ADD NOT FILLED · BTC 74,000 PE

Tried to sell 425 more at 7.5 or better (never under 3.0), because the CE target bought back 425.
Nothing was sold: its window closed.
Still short 425, unchanged.
09:13 IST · strategy · LIVE
```

---

## Behaviour that changed

- **The desk's $5 premium floor gives way to the add's own minimum, for adds
  only.** A new entry at 4.00 is still refused; an add at 4.00 with a $3 minimum
  goes. Set the minimum to 5 if you want the old floor for adds too.
- **A target that fills in part keeps the stop on what is left** (the fix from
  earlier today). Before, the first piece cancelled the stop.
- **A stop that fills in part:** the desk's stop watch now closes the rest at
  market while the mark is above the stop.
- **Short limit:** with 425 a leg, a full add keeps you at 850 short, because the
  CE was already bought back. Your limit on screen is 1,240. Other open
  positions count too.

---

## Not covered yet, or needs your OK

- [ ] **Deploy** — with nothing open. Nothing here is live until then.
- [ ] **Turn the setting on** in the strategy you want (Strategy → Edit → After a
      target). It is off on every strategy, including the seeded ones.
- [ ] **One 1-lot live add, with you watching**, before running it at 425: check
      the fill, the resized target and stop, and the Telegram message against
      Delta's own screen. Only after you say go at the time.
- [ ] **The auto-trading master switch** gates adds the same way it gates
      entries, but that wiring has no automated test of its own.
- [ ] **A market exit that fills only in part** (Close now or the stop watch)
      still leaves the rest short with nothing retrying — an older gap that
      matters more at 850. It is in `docs/TODO.md`.

---

## Check it yourself

```bash
cd app/server
npm test                                              # all 563
npx tsx --test test/strategy/add.test.ts              # the rules, 27
npx tsx --test test/trading/add-to-position.test.ts   # after the add, 16
npx tsx --test test/strategy/adder.test.ts            # end to end on paper, 11

cd ../web
npx vitest run                                        # all 353
```

Test names above are shortened; each is quoted from its file. Full notes:
`docs/TODO.md` → "Add to the other leg when a target fills — 11 Sep 2026".
