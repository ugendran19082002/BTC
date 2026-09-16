import type { MarketRead, TimeframeRead } from '../market/moves.js';
import type { Snapshot } from '../market/chain.js';

/**
 * Which way the tape is leaning, and whether that is worth acting on.
 *
 * ## What this is, and what it is not
 *
 * The desk's *tested* rule is one line long and lives in `recommend.ts`: BTC up
 * or down more than 2% in 24 hours, confirmed by the daily EMA stack, splits
 * the lots 70/30. It has a 733-day record behind it and nothing here replaces
 * it.
 *
 * This is the reading a person does before trusting that split: seven inputs
 * across five timeframes, each normalised to -1..+1, weighted, and summed into
 * one number. It exists because "24h +0.25%, 12h -0.13%, 6h -0.15%, 1h -0.16%,
 * 15m +0.27%" is five facts that do not add up to a side, and a screen that
 * shows five facts and no verdict leaves the adding-up to somebody at 05:30 in
 * the morning.
 *
 * **Description, not instruction.** `verdict()` returns what it sees and the
 * reasons; what the desk does with it is decided in `recommend.ts`, behind a
 * setting, so a rule with a record is never quietly replaced by a rule without
 * one.
 *
 * ## The inputs, and the ones deliberately missing
 *
 * Each returns -1..+1 from data the desk already fetches:
 *
 *   24h return       the tested input, scaled so the 2% threshold reads 1.0
 *   daily EMA stack  9 against 21 against 50
 *   4h EMA stack     the regime
 *   1h EMA stack     the direction that matters over a 12-hour contract
 *   momentum         1h and 15m RSI, and which way they are moving
 *   structure        higher highs and higher lows on the 1h, or the mirror
 *   VWAP             where price sits against the volume-weighted average
 *
 * **CVD and funding/basis are not here.** Cumulative delta needs the aggressor
 * side of every trade and funding needs the perpetual; the desk fetches
 * neither. Inventing them from candle direction would put a number on the
 * screen that looks like order flow and is not, which is worse than the gap.
 * The weights below sum to 1 over what is actually measured.
 *
 * ADX does not vote. It scales: agreement in a market going nowhere is
 * agreement about noise, so the whole score is damped when no timeframe is
 * trending. That is the difference between "everything points up" on a day
 * that moves 2% and the same words on a day that moves 0.2%.
 */

/** Past this, a side is worth naming. Under it, the tape has not said. */
export const SIDE_BAR = 0.45;
/** The tested threshold, which is also what a 24-hour return of 1.0 means here. */
export const RETURN_SCALE_PCT = 2;
/** Below this ADX nothing is trending, and agreement is damped towards nothing. */
export const ADX_FLOOR = 15;
/** At or above this ADX the score is taken at face value. */
export const ADX_FULL = 25;

export const WEIGHTS = {
  return24h: 0.15,
  daily: 0.15,
  fourHour: 0.20,
  oneHour: 0.25,
  momentum: 0.10,
  structure: 0.10,
  vwap: 0.05,
} as const;

export type Input = { key: keyof typeof WEIGHTS; label: string; value: number | null; why: string };

export type Gate = {
  key: 'direction' | 'timeframes' | 'expectedMove' | 'structure' | 'execution';
  label: string;
  /** Null when the gate has nothing to read, which is never a pass. */
  pass: boolean | null;
  why: string;
};

export type Verdict = {
  /** -1..+1, the weighted sum, damped when nothing is trending. */
  score: number | null;
  side: 'bullish' | 'bearish' | null;
  /** Each input's own normalised reading, for the screen. */
  inputs: Input[];
  gates: Gate[];
  /** How many gates passed, and how many could be read at all. */
  passed: number;
  readable: number;
  /** True when the tape says a side AND at least four of five gates agree. */
  confirmed: boolean;
  /** One line, for the journal and the card. */
  summary: string;
};

const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));

/** The EMA stack as -1..+1: both crossings agreeing is the whole of it. */
export function stackScore(t: TimeframeRead | undefined | null): number | null {
  if (!t || t.ema9 === null || t.ema21 === null) return null;
  const fast = Math.sign(t.ema9 - t.ema21);
  if (t.ema50 === null) return fast * 0.6;
  const slow = Math.sign(t.ema21 - t.ema50);
  // Both the same way is the full reading; disagreement is the fast one, halved.
  return fast === slow ? fast : fast * 0.4;
}

/**
 * RSI on the 1h and the 15m, as level and as slope.
 *
 * The level says where momentum is (50 is nothing, 70 is stretched), the slope
 * says which way it is going, and they are averaged rather than one chosen:
 * an RSI of 62 falling and an RSI of 48 rising are the same reading from two
 * different places.
 */
export function momentumScore(hour: TimeframeRead | undefined, quarter: TimeframeRead | undefined): number | null {
  const parts: number[] = [];
  for (const t of [hour, quarter]) {
    if (!t) continue;
    if (t.rsi14 !== null) parts.push(clamp((t.rsi14 - 50) / 20));
    if (t.rsiSlope !== null) parts.push(clamp(t.rsiSlope / 5));
  }
  if (!parts.length) return null;
  return clamp(parts.reduce((a, b) => a + b, 0) / parts.length);
}

/** Price against VWAP: a percent away is a full reading either way. */
export function vwapScore(t: TimeframeRead | undefined): number | null {
  if (!t || t.vwapDistPct === null) return null;
  return clamp(t.vwapDistPct / 1);
}

/**
 * How much of the reading to believe, from the strongest ADX on the board.
 *
 * Not an average: one timeframe genuinely trending is enough for the reading to
 * mean something, and averaging it against four quiet ones would throw that
 * away.
 */
export function trendStrength(market: MarketRead | null): { factor: number; adx: number | null } {
  const values = (market?.timeframes ?? [])
    .map((t) => t.adx14)
    .filter((v): v is number => v !== null);
  if (!values.length) return { factor: 1, adx: null };
  const best = Math.max(...values);
  const factor = clamp((best - ADX_FLOOR) / (ADX_FULL - ADX_FLOOR), 0.35, 1);
  return { factor, adx: best };
}

const tfOf = (m: MarketRead | null, tf: string) => m?.timeframes.find((t) => t.tf === tf);

/** Every input, normalised, with the words that explain each number. */
export function inputsOf(market: MarketRead | null): Input[] {
  const day = tfOf(market, '1d');
  const four = tfOf(market, '4h');
  const hour = tfOf(market, '1h');
  const quarter = tfOf(market, '15m');
  const r24 = market?.return24h ?? null;

  const pct = (v: number | null | undefined, places = 2) =>
    v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(places)}%`;
  const stackWords = (t: TimeframeRead | undefined) => {
    const v = stackScore(t);
    if (v === null) return 'no EMAs to read';
    return v > 0 ? 'EMA stack rising' : v < 0 ? 'EMA stack falling' : 'EMAs crossed';
  };

  return [
    {
      key: 'return24h',
      label: '24-hour return',
      value: r24 === null ? null : clamp(r24 / RETURN_SCALE_PCT),
      why: r24 === null ? 'no 24-hour return' : `${pct(r24)} against the ${RETURN_SCALE_PCT}% mark`,
    },
    { key: 'daily', label: 'Daily trend', value: stackScore(day), why: stackWords(day) },
    { key: 'fourHour', label: '4-hour trend', value: stackScore(four), why: stackWords(four) },
    { key: 'oneHour', label: '1-hour trend', value: stackScore(hour), why: stackWords(hour) },
    {
      key: 'momentum',
      label: 'Momentum',
      value: momentumScore(hour, quarter),
      why: hour?.rsi14 == null
        ? 'no RSI to read'
        : `1h RSI ${hour.rsi14.toFixed(0)}${hour.rsiSlope == null ? '' : `, ${hour.rsiSlope >= 0 ? 'rising' : 'falling'}`}`,
    },
    {
      key: 'structure',
      label: 'Structure',
      value: hour ? hour.structure : null,
      why: !hour ? 'no hourly bars'
        : hour.structure === 1 ? 'higher highs and higher lows on the hour'
          : hour.structure === -1 ? 'lower highs and lower lows on the hour'
            : 'no clean structure on the hour',
    },
    {
      key: 'vwap',
      label: 'Against VWAP',
      value: vwapScore(hour),
      why: hour?.vwapDistPct == null ? 'no VWAP to read' : `${pct(hour.vwapDistPct)} from the hourly VWAP`,
    },
  ];
}

/**
 * The weighted score, over whatever could be read.
 *
 * Missing inputs are dropped and the weights renormalised over the rest, rather
 * than counted as zero: a VWAP the feed did not supply is not a neutral market,
 * and treating it as one drags every reading towards the middle. Null when
 * nothing at all could be read.
 */
export function directionScore(market: MarketRead | null): { score: number | null; inputs: Input[]; adx: number | null } {
  const inputs = inputsOf(market);
  let sum = 0;
  let weight = 0;
  for (const i of inputs) {
    if (i.value === null) continue;
    sum += WEIGHTS[i.key] * i.value;
    weight += WEIGHTS[i.key];
  }
  const { factor, adx } = trendStrength(market);
  if (weight === 0) return { score: null, inputs, adx };
  return { score: clamp((sum / weight) * factor), inputs, adx };
}

/**
 * The hierarchy: 1d sets the context, 4h the regime, 1h the direction, 15m the
 * confirmation. All four the same way is a confirmed side; anything else is
 * not, however strong the score.
 */
export function timeframeAgreement(market: MarketRead | null): { score: number | null; agreeing: number; of: number; words: string } {
  const order: { tf: string; label: string }[] = [
    { tf: '1d', label: '1D' },
    { tf: '4h', label: '4H' },
    { tf: '1h', label: '1H' },
    { tf: '15m', label: '15m' },
  ];
  const reads = order.map((o) => ({ ...o, v: stackScore(tfOf(market, o.tf)) })).filter((o) => o.v !== null);
  if (!reads.length) return { score: null, agreeing: 0, of: 0, words: 'no timeframes to read' };
  const up = reads.filter((r) => r.v! > 0).length;
  const down = reads.filter((r) => r.v! < 0).length;
  const agreeing = Math.max(up, down);
  const words = reads.map((r) => `${r.label} ${r.v! > 0 ? 'up' : r.v! < 0 ? 'down' : 'flat'}`).join(', ');
  return { score: (up - down) / reads.length, agreeing, of: reads.length, words };
}

/**
 * How far the nearest short strike sits, in expected moves.
 *
 * The number that says whether a strike is actually far away, as opposed to
 * far away in dollars on a day that moves that far routinely. 1.0 means the
 * expected move reaches it exactly.
 */
export const emBuffer = (spot: number, strike: number, expectedMove: number | null): number | null =>
  expectedMove === null || !(expectedMove > 0) ? null : Math.abs(strike - spot) / expectedMove;

export type ExecutionRead = {
  /** Worst spread, as a fraction of the mid, among the strikes being considered. */
  worstSpreadPct: number | null;
  /** How old the quote is, in milliseconds. */
  quoteAgeMs: number | null;
  /** True when a hedge is available for every leg the plan wants. */
  hedged: boolean | null;
};

/**
 * The five gates, and the verdict.
 *
 * Four of five must pass, and the score must name a side. A gate that cannot be
 * read is not a pass -- the same rule the sudden-move gate follows, and for the
 * same reason: an unread risk is not a small one.
 */
export function verdict(i: {
  market: MarketRead | null;
  snap: Pick<Snapshot, 'spot' | 'expectedMove'> | null;
  /** The strikes the desk is actually considering, for the expected-move gate. */
  shorts?: { ce: number | null; pe: number | null };
  execution?: ExecutionRead;
  /** How far a short must sit, in expected moves, to pass gate 3. */
  minBuffer?: number;
  maxSpreadPct?: number;
}): Verdict {
  const minBuffer = i.minBuffer ?? 1;
  const maxSpread = i.maxSpreadPct ?? 0.07;
  const { score, inputs, adx } = directionScore(i.market);
  const mtf = timeframeAgreement(i.market);
  const side = score === null ? null : score >= SIDE_BAR ? 'bullish' : score <= -SIDE_BAR ? 'bearish' : null;

  const gates: Gate[] = [];

  gates.push({
    key: 'direction',
    label: 'Market direction',
    pass: score === null ? null : Math.abs(score) >= SIDE_BAR,
    why: score === null
      ? 'nothing to read the tape from'
      : `score ${score >= 0 ? '+' : ''}${score.toFixed(2)} against the ${SIDE_BAR} bar`
        + (adx === null ? '' : `, strongest ADX ${adx.toFixed(0)}`),
  });

  gates.push({
    key: 'timeframes',
    label: 'Timeframes agree',
    pass: mtf.score === null ? null : mtf.agreeing >= Math.max(3, mtf.of - 1) && (side === null || Math.sign(mtf.score) === (side === 'bullish' ? 1 : -1)),
    why: mtf.score === null ? 'no timeframes to read' : `${mtf.agreeing} of ${mtf.of} — ${mtf.words}`,
  });

  // Gate 3: the strikes the desk would sell, measured in expected moves.
  const spot = i.snap?.spot ?? null;
  const em = i.snap?.expectedMove ?? null;
  const buffers = [i.shorts?.ce ?? null, i.shorts?.pe ?? null]
    .filter((k): k is number => k !== null && spot !== null)
    .map((k) => emBuffer(spot!, k, em));
  const worstBuffer = buffers.length && buffers.every((b) => b !== null)
    ? Math.min(...(buffers as number[]))
    : null;
  gates.push({
    key: 'expectedMove',
    label: 'Strikes clear the expected move',
    pass: worstBuffer === null ? null : worstBuffer >= minBuffer,
    why: worstBuffer === null
      ? 'no expected move, or no strike chosen yet'
      : `nearest short is ${worstBuffer.toFixed(2)}× the expected move away, against ${minBuffer.toFixed(2)}×`,
  });

  // Gate 4: what the board itself is doing, from the sudden-move reading's own
  // inputs -- a quiet board with the walls outside the expected move.
  const containment = spot !== null && em !== null && i.shorts?.ce != null && i.shorts?.pe != null
    ? { low: i.shorts.pe, high: i.shorts.ce }
    : null;
  gates.push({
    key: 'structure',
    label: 'Option structure',
    pass: containment === null ? null : containment.low < spot! && containment.high > spot!,
    why: containment === null
      ? 'no pair of strikes to judge'
      : `selling ${containment.low} and ${containment.high} around ${Math.round(spot!)}`,
  });

  const ex = i.execution;
  const spreadOk = ex?.worstSpreadPct == null ? null : ex.worstSpreadPct <= maxSpread;
  gates.push({
    key: 'execution',
    label: 'Execution and hedge',
    pass: spreadOk === null ? null : spreadOk && ex!.hedged !== false,
    why: ex?.worstSpreadPct == null
      ? 'no book to read'
      : `worst spread ${(ex.worstSpreadPct * 100).toFixed(1)}% against ${(maxSpread * 100).toFixed(0)}%`
        + (ex.hedged === false ? ', and no hedge available' : ''),
  });

  const passed = gates.filter((g) => g.pass === true).length;
  const readable = gates.filter((g) => g.pass !== null).length;
  const confirmed = side !== null && passed >= 4;

  return {
    score,
    side,
    inputs,
    gates,
    passed,
    readable,
    confirmed,
    summary: confirmed
      ? `${side === 'bullish' ? 'Bullish' : 'Bearish'} side confirmed — ${passed} of 5 gates`
      : side === null
        ? `No side: the tape has not said${score === null ? '' : ` (${score >= 0 ? '+' : ''}${score.toFixed(2)})`}`
        : `${side === 'bullish' ? 'Bullish' : 'Bearish'} lean, not confirmed — ${passed} of 5 gates`,
  };
}
