# 0003 — Position is counted from fills, never assumed

**Status:** accepted · **Since:** September 2026

## Decision

[machine.ts](../../app/server/src/trading/machine.ts) is a pure reducer over
fills with no I/O, so every case in the test matrix can be built by hand.

    position = exit.size - entry.size

Written that way round so a closed trade is `0` and never `-0`, which is a
real distinction to `Object.is` and was a real bug.

Reduce-only is enforced at *fill* time, not only at submission: a take-profit
and a stop both printing would otherwise turn a short into a long.

## Consequences

When the exchange and the fills disagree, the fills are looked for first
(`recoverFills`), and only an unexplained gap is recorded as `reconciled`.
With two strategies on one contract, a trade's share is Delta's net less the
other trades', and a gap nobody can attribute is not written into either --
see [0011](0011-one-trade-per-contract.md).

**Tests:** `test/trading/machine.test.ts`.
