# 0014 — One signal trade per contract on an account; exits recovered from Delta's fills

**Status:** accepted and built, 14 October 2026 · **Narrows:** [0011](0011-one-trade-per-contract.md) -- the
engine still keeps several trades on one contract apart (a ticket trade beside a strategy's), but the signal
runner no longer opens a second one.

## Context

On the night of 13-14 October the desk's signal strategies held 17 to 55 trades each on a few strikes -- 84,400 CE,
82,000 PE, 84,600 CE, 81,800 PE -- every trade one lot, every trade with its own reduce-only target and stop on
Delta. Delta keeps a contract's reduce-only orders to its position: "the size of a reduce-only order cannot exceed
the size of open position", and as the position shrinks it shrinks them. On those contracts the desk's targets were
taken off and put back about 3,000 times between 9:30 PM and 8 AM -- 1,031 times on the 55-trade 84,400 CE, none on
contracts held by four or five. From 8:03 to 8:41 thirty positions on three of them went flat at Delta with nothing
the desk had recorded to explain it: the order history it searched (a contract's newest fifty orders) no longer
reached the buy-backs, and each was written off as "closed on Delta itself" with its P&L uncounted.

## Decision

1. **One trade per contract on an account, for the signal runner.** A strike the account already holds -- or is
   entering -- is left off the board for the next signal (`runner.ts` `takeSignal`), and the rule picks the next
   strike out, as if that one were not quoted; with none left, the signal is refused and says how many strikes were
   left out. The backtest does the same (`simulateTogether`: on the account where its books share one, else in the
   book), so the live check still compares like with like.
2. **Missed exits are recovered from Delta's fills.** A reconcile reads the contract's two hundred newest orders,
   then its fills since the trade began (`GET /v2/fills`, by product and start time); a fill names only Delta's
   order, so the order is looked up by that id and its client id says whose it is (`recoverFromFills`). The exit
   is booked at its real price.
3. **Delta's reason is journaled**, and a target Delta keeps cancelling is held back. A cancel Delta made carries
   its `cancellation_reason` onto the trade's `sibling_cancelled` event. Four of one trade's targets cancelled
   inside ten minutes, and its target is held off the book for fifteen -- said once, with the reason; the stop is
   never held back.

## Consequences

- Fewer trades on a busy evening: a run of same-side signals walks out along the strikes the rule allows, and the
  last ones find none. The backtest shows the same.
- The positions opened before this change, shared as they are, close on today's expiry; the fills recovery and the
  hold cover them until then.
- A trade with its own client ids on a fill another trade sent is never taken: the stem decides.
