# Entry methods — the reference formulas, and the audit against them

The owner's reference logic for the twelve entry methods (30 Sep 2026), kept
as the specification the engine is held to, and the audit that brought the
engine ([`app/server/src/entry/`](../../app/server/src/entry/)) in line with
it. How the methods are read, gated and paper-logged is in
[entry-setups.md](entry-setups.md).

**The timeframe is not a method of its own.** Each of the twelve is read on one
timeframe ("without timeframe"), and again with the chain as its
confirmation layers ("with timeframe"): 4H / 1H direction, 30m / 15m the
range that matters, 5m the entry, 3m momentum confirmation, 1m execution.

---

## Notation

| Symbol | Meaning | In the code |
|---|---|---|
| C, O, H, L, V | close, open, high, low, volume | `Candle` |
| ATR | ATR(14), Wilder's | `atr` |
| EMA20 | EMA(20) of the closes | `ema` |
| VWAP | session VWAP (the desk's day, from 00:00 UTC) | `vwapBand` |
| RVOL | V / SMA(V, 20) | `rvol` |
| CloseLocation | (C − L) / (H − L) | `closeLocation` |
| MSS / BOS | market structure shift / break of structure: a close through a swing | `lastBreak` |
| FVG | fair value gap: Low[0] > High[2] (bullish) | `openFvgs` |
| OB | order block: the last opposite candle before a displacement that broke structure | `orderBlocks` |
| Δ, CVD | aggressor delta (buy − sell), and its running sum | the recorded tape, `flow` |

## The twelve, as specified and as built

Every threshold below is a named constant in
[`methods.ts`](../../app/server/src/entry/methods.ts) (`RVOL_MIN`,
`BREAKOUT_CLOSE_LOC`, ...). They are the design, not measurements; the paper
log judges them. Shorts are the mirror of each long.

| # | Method | Reference | Built as |
|---|---|---|---|
| 1 | Breakout | Close > RangeHigh20 AND RVOL ≥ 1.5 AND CloseLocation ≥ 0.70 | the same; entry just under the close, stop the bar's low |
| 2 | Breakout + retest | BreakoutConfirmed AND Low ≤ BrokenLevel + tolerance AND Close > BrokenLevel AND rejection | the same; no close back through the level (0.1 ATR) since the break; touch = within 0.3 ATR; rejection = a 30% wick or a candle its way |
| 3 | Liquidity sweep | Low < SwingLow − buffer AND Close > SwingLow AND Close > LastLowerHigh (MSS) | the same, buffer 0.1 ATR, the swing still untouched; entry a limit at the MSS level |
| 4 | FVG retest | BullishDisplacement AND FVG AND Price ∈ FVG AND rejection / close up | the same; the touch in the last 3 bars, the reaction a candle closing up past the gap's middle |
| 5 | Order-block retest | ValidBullishOB AND price enters OB AND rejection AND MSS/BOS; invalid on Close < OB_Low | the same; the OB within 5 bars of the displacement that broke a swing; rejection = closing back over the block |
| 6 | BOS | Close > PreviousSwingHigh AND displacement AND trendAligned (retest preferred) | the same; entry a limit at the broken level -- the retest |
| 7 | MSS / CHoCH | bearish structure, sweep, bullish displacement, Close > LastLowerHigh; then MSS + retest | the same |
| 8 | Momentum | Body ≥ 1.5 ATR AND RVOL ≥ 1.5 AND CloseLocation ≥ 0.75 AND FollowThrough AND not extended | the same; follow-through = the next bar closes further its way; extended = opened over 3 ATR from EMA20 (no chase) |
| 9 | Pullback | TrendBullish (HH + HL) AND Price ≈ EMA20 AND rejection AND previous-high break | the same; the trend is the EMA stack and the swings agreeing; ≈ = within 0.2 ATR in the last 4 bars; rejection = closed back over EMA20; micro BOS = closed over the prior bar's high |
| 10 | VWAP / mean reversion | \|C − VWAP\| / σ ≥ 2 AND reversal candle AND delta improves AND returning to VWAP; off on a trend day | the same; the stretch read at the last 3 bars' extreme; trend day = efficiency over 20 bars > 0.6; TP1 VWAP |
| 11 | Order flow | AtKeyLevel AND absorption AND DeltaFlip AND CVDConfirm AND MicroBOS | the same; absorption = delta against the level and price held; CVD confirm = its low behind it and coming off it; micro BOS on 1m |
| 12 | Options / derivatives | OI wall + price reaction + structure confirmation + flow confirmation, big-move risk compatible; never the wall alone | the same; wall held = closed back over it; reaction = closed past the prior bar; the tape its way over 5 minutes |

A step the data cannot answer (the tape not recorded, no option board, no
big-move reading) is **not read** and never counts as confirmed.

---

## The audit (30 Sep 2026)

Every method, primitive, gate and the paper grader was read against the
reference and against what it claims to do. What was wrong, and is fixed --
each with a test that fails on the old code:

| Where | Was | Now |
|---|---|---|
| `atr` | a plain average of the last 14 true ranges, described as Wilder's | Wilder's: averaged, then smoothed 1/14 a bar |
| `rvol` | volume over the **median** of 20 | over the **average** of 20, as the reference; any bar, not only the newest |
| `lastBreak`, `orderBlocks` | the swing broken was the newest one *confirmed later* -- the break read at an older bar was not what that bar could have known | the swing known before the bar closed (`PIVOT_K` bars after it had closed) |
| `lastSweep` | any tick past a swing; a swing already traded through could be "swept" again | past it by a buffer (0.1 ATR), and only a swing still untouched |
| `openFvgs` | a gap under a displacement in *either* direction | the displacement's own direction |
| `orderBlocks` | the last opposite candle anywhere before the displacement | within 5 bars: the move's origin |
| 2 Breakout + retest | "rejection" read on the last bar even when it had not come near the level | the retest bar itself touches the level and closes beyond it |
| 4 FVG, 5 OB | a touch any time since the zone formed, then any candle closing its way later | the touch in the last 3 bars, the reaction on the newest |
| 8 Momentum | "follow-through" was the close location; no next-bar check; RVOL vs the median at 1.8 | close location ≥ 0.75 **and** the next bar closing further; RVOL ≥ 1.5 |
| 10 VWAP | the stretch read at the close only -- the reversal bar that brings the close back made the setup vanish at the moment it formed | read at the last 3 bars' extreme; delta-improving and returning-to-VWAP steps added |
| 11 Order flow | "big prints" in place of CVD and the micro BOS | CVD turn and a 1m micro BOS, per the reference |
| 12 Options | a big-move reading with no direction counted as "not read" (never TRADE) | compatible; the wall-held, structure and tape steps added |
| 6 BOS | a counter-trend break returned nothing | shown, with "trend aligned" failed |
| `rrAfterFees` | the loss side charged the fee of exiting at the *target* | the fee of exiting at the *stop* |
| Paper grading | the fill window counted from the trigger bar -- an FVG or OB forty bars old expired on its first minute | from when the setup was first on the board |
| Paper grading | the minute the setup was seen in was graded, though it traded partly before the setup existed | from the first whole minute after |

What was checked and is right as it was: closed bars only everywhere; the
EMA seed; the swings' confirmation (`PIVOT_K` = 2); the gates' order (the
method's own block first); the stop buffer and the 0.3-2.5 ATR band; targets
from liquidity nearest first; a bar touching the stop and TP1 graded as the
stop; a gap through the stop filled at the open; the quality score never
shown as a probability.

## The replay

[`app/server/scripts/entry-study.ts`](../../app/server/scripts/entry-study.ts)
replays methods 1-10 over the cached 5m history and grades every TRADE the
way the paper log does; the output is
[research/ENTRY-STUDY.txt](../../research/ENTRY-STUDY.txt). Methods 11 and 12
need the tape and the option board, which this history does not have.
