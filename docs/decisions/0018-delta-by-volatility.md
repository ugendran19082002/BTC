# 0018 — A signal strategy's delta may be set by how volatile it is at each signal

**Status:** accepted and built, 17 October 2026 · **Stands with** [0013](0013-entry-setups-measured-before-trusted.md), [0017](0017-methods-picked-daily.md)

## Context

Every live signal strategy sold at one delta, 0.10, whatever the market was doing. The research on two years of
settled chains found that a sold leg which has doubled goes on to four times 53–55% of the time on volatile days and
39–42% on calm ones: the same distance is not the same risk on both. The backtest's volatility study
([signal-backtest.md](../features/signal-backtest.md)) was asked the question on the desk's own trades.

Measured on a copy of the live data, the 16 live strategies by their own rules, 1 lot, 1–17 Oct 2026; Normal 0.10 and
High 0.08 held, Low moved, read by ATM IV:

| Low Δ | Net vs 0.10 | Won | SL hits | Worst day |
|---|---|---|---|---|
| 0.10 (as before) | — | 86.8% | 90 | −₹2 |
| 0.15 | −₹12 | 87.2% | 78 | −₹2 |
| 0.18 | +₹177 | 87.1% | 78 | −₹2 |
| 0.19 | +₹220 | 87.0% | 78 | −₹2 |
| 0.20 | +₹89 | 86.2% | 92 | −₹63 |
| 0.30 | +₹543 | 86.0% | 94 | −₹12 |

The gain rises smoothly to 0.19 and breaks at 0.20: stops and a losing day appear. Most of any gain came on two days
of the seventeen. It is a small edge on a short sample, not a proven one.

## Decision

1. **Off unless switched on, per signal strategy** (Strike & lots → Delta by volatility). Off, the strategy's own delta.
2. **One source at a time:** ATM IV (to begin with) or ATR 2h — the very readings the backtest makes at a fill
   (`volLevelNow` in `report/signal-backtest.ts`), so a backtest by the strategy is what the desk does.
3. **Low 0.18 · Normal 0.10 · High 0.08 to begin with**, each 0.02 to 0.50. One step under the break at 0.20; the form
   warns above 0.19.
4. **Only for a strategy that sells, by delta, with one rule all window** — it replaces one number. Refused in words
   otherwise.
5. **A level that cannot be read keeps the strategy's own delta** — no IV reading in the 6 minutes before, too few days
   before, or any failure. A reading never stops a signal.
6. **The level is decided at the signal, once**, and written on the signal's line in the history (`strategy_signal_runs`):
   which level, by which source, which delta — or that it was unknown.

## Consequences

- Turned on with live orders on, it changes real orders from the next signal: the form says so, and the advice is to
  run it with live orders off first.
- The backtest by a strategy and the live check read the strategy's own source; the "By volatility" table follows it.
- On calm days the strike sold is nearer the money; a calm market that breaks catches it. That is the risk bought for
  the extra premium, and why Low stops short of 0.20.
