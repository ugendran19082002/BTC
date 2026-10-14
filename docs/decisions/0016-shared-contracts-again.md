# 0016 — Several trades may share a contract, and several strategies one signal

**Status:** accepted and built, 14 October 2026 · **Replaces** rule 1 of
[0014](0014-one-signal-trade-per-contract.md) · **Stands with** [0011](0011-one-trade-per-contract.md) and
[0015](0015-read-the-whole-book.md)

## Context

0014 stopped the signal runner opening a second trade on a contract the account already held. It answered target
churn on contracts shared by 17 to 55 trades. By noon the real cause had been found ([0015](0015-read-the-whole-book.md)):
the desk read only a hundred of the account's open orders, placed second stops beside stops it could not see, and
those crowded the contracts' reduce-only room. With the whole book read and leftovers swept, 23 and more trades
shared the 82,400 PE with no target cancelled.

The rule's cost, measured on a copy of the live data, by the backtest that matches the desk signal for signal:

| 1–14 Oct, the live strategies | Trades | Net |
|---|---|---|
| One trade per contract | 128 | about +$0.54 |
| Several per contract | 842 | about +$4.23 |

Most signals found the nearer strikes held, and the next ones out paid under the 10.00 premium floor. On 14 Oct the
desk had placed 213 orders before the rule; the backtest with it took 37.

A "one trade per signal" rule (a signal one strategy of the account had traded, skipped by the others) was built
the same afternoon and withdrawn before it went live. The owner: "allow many trades on one strike; allow two
strategies to take the same signal".

## Decision

1. **Several trades may share a contract.** The runner sells the strike its rule picks, held or not; the backtest
   the same. Each trade keeps its own exits ([0011](0011-one-trade-per-contract.md)).
2. **Several strategies may trade one signal.** Each strategy takes every signal its own rules and limits allow,
   whatever another strategy of the account did with it -- as before 14 Oct. The backtest, the live check and a
   portfolio under one limit work each book's signals the same way.

## Consequences

- The backtest of 1–14 Oct matches the desk's 213 orders of 14 Oct, signal for signal.
- Two strategies on the same method and time frame each hold a trade on a signal they both take: two positions,
  two sets of exits, on what may be one contract.
- What keeps a shared contract's exits right is [0015](0015-read-the-whole-book.md): the whole book read, leftovers
  swept, a target Delta keeps cancelling held off.
