# 0006 — A target is a resting limit; a stop is an exit, judged here and backstopped at Delta

**Status:** accepted · **Since:** 10 September 2026, revised 24 and 29 September 2026

## Context

The two exits of a short option fail in opposite ways, and each revision below
came from a live loss:

- **9-10 Sep.** A target sent as a trigger fired at once ([0002](0002-simulator-is-not-the-venue.md)).
  A target replaced by a market buy when the mark touched it paid a 2.00 offer
  against a 1.00 target, on two legs.
- **24 Sep.** A stop asked for at 70 filled at 79. It went out as a limit
  priced 50% through its own trigger -- a market order wearing a hat -- and
  swept every offer up to 105.
- **26 and 28 Sep.** On thin near-expiry options Delta's *mark* ran far above
  anything tradeable: C-84400 marked 13.8 against a 4.4 / 5.2 book, its 16.0
  stop fired a minute after entry and bought back at 7.9, and the option
  expired at 0.1. C-83200's 44.2 stop filled at 24.8.

## Decision

- **Target -> a resting reduce-only limit buy.** It "can only be executed at
  the limit price or lower" and "may never be executed". Both halves are the
  point. It is never replaced by a market buy when the mark touches the level.
- **Stop -> judged by the desk, on the offer.** `stopIfReached` closes when the
  *offer* has been at or through the stop for `STOP_CONFIRM_MS` (15 s) -- a
  short is bought back at the offer, so the offer is the price that says the
  stop is really reached.
- **The stop at Delta is a backstop** (`backstopFor`): a trigger further out --
  the stop plus its distance from entry, at least a quarter of the stop again --
  where only a real run, or this process being down, reaches it. It is the one
  protection that survives the process dying.
- **A stop-limit's slack is `STOP_LIMIT_SLACK` = 15%**, with a five-tick floor;
  `slippageOf()` measures every exit against what asked for it, and a fill
  missing its trigger by `SLIPPAGE_ALERT_PCT` (5%) or more raises an alarm to
  the phone and the error log.
- **Entries and manual closes are limits, never market**, where a price floor
  or ceiling protects the fill.

## Consequences

A target may never fill if nobody sells there; the position then stays on until
the stop, the exit time or settlement. The backstop's distance means a crash
while the process is down costs more than the stop the trader set.

**Where:** [engine.ts](../../app/server/src/trading/engine.ts)
(`stopIfReached`, `backstopFor`), [money.ts](../../app/server/src/trading/money.ts) ·
**Tests:** `test/trading/stop-orders.test.ts`, `orders.test.ts` cases 75-80b ·
**Sources:** [Delta Exchange API](https://docs.delta.exchange/),
[SEC -- stop orders](https://www.sec.gov/answers/stopord.htm).
