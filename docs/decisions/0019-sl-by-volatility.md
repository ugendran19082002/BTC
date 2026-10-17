# 0019 — A signal strategy's option SL may be set by how volatile it is at each signal

**Status:** accepted and built, 17 October 2026 · **Stands with** [0006](0006-target-is-a-price-stop-is-an-exit.md), [0018](0018-delta-by-volatility.md)

## Context

On two years of settled chains (`chain.db`, CE + PE at the 15-point floor 12 h before settlement), a sold leg that had
doubled went on to four times 53–55% of the time on volatile days and 39–42% on calm ones. An SL set tighter when it
is volatile and wider when calm did better than one SL in every one of twelve variants, and the reverse did worse in
all twelve. The owner asked for it in the signal strategy form, as delta by volatility (0018) is.

Measured on a copy of the live data, the 14 live strategies as they stand (delta by ATM IV, SL +160%), 1 lot,
1–17 Oct 2026, read by ATM IV, 1,831 trades:

| SL Low / Normal / High | Net vs +160% | SL hits | Worst day |
|---|---|---|---|
| 160 / 160 / 160 (the control: the same) | ₹0 | 78 | −₹4 |
| 250 / 200 / 150 | +₹18 | 68 | −₹4 |
| 300 / 160 / 100 | −₹62 | 104 | −₹4 |
| 200 / 160 / 120 | −₹31 | 94 | −₹4 |
| 150 / 200 / 250 (wider when volatile) | −₹11 | 58 | −₹17 |

On these strategies the option SL closes few trades -- 78 of 1,831; the perp's SL and TGT and the target steps close
the rest -- so the SL by level moves little either way. 250 / 200 / 150 is the only rule not to lose, by noise.

## Decision

1. **Off unless switched on, per signal strategy** (Entry & exit → SL by volatility). Off, the strategy's own SL.
2. **Low +250% · Normal +200% · High +150% to begin with**, each +10% to +1,000% of the premium. Wider when calm,
   tighter when volatile, as the chains found; the form warns when High is set wider than Low.
3. **One source with the delta by volatility.** Both on, both read one source -- one reading a signal, never "low" for
   the delta and "high" for the SL -- refused otherwise; the form changes both together.
4. **Only an SL by %, with no SL time steps, on a strategy that sells.** It replaces one number for the whole trade.
5. **Decided once, at the signal, and kept to the exit.** The trade is placed with it (`exitsNow`): the desk's stop watch
   and the backstop at Delta are set from it. Timed target steps do not move it (the stepper moves only the leg whose
   stage changed, and the SL has none).
6. **A level that cannot be read keeps the strategy's own SL.** Written on the signal's line with the delta's:
   "· high volatility (ATM IV): Δ ≤ 0.08, SL +150%".

## Consequences

- No measured edge on today's strategies. It is there to be tried with live orders off, and for strategies whose option
  SL does more of the work.
- The backtest by a strategy, its live check and the volatility study read the strategy's own SL by level and source.
