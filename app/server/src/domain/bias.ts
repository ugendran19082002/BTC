import type { Bias as PatternBias, Pattern } from './patterns.js';
import type { Indicator } from './indicators.js';
import type { Side } from './market-state.js';

/**
 * Up or down, from everything measured, in one word.
 *
 * The desk knows a hundred things at once -- forty candle shapes, the market
 * structure, a dozen readings, the tape, the board, six timeframes. The one
 * question somebody opens the chart to answer is still *which way*, and
 * answering it with "here are sixty facts" is not answering it.
 *
 * So this is a vote, and it is described as a vote. Every reading that has a
 * direction gets one, weighted by how much it is worth hearing from: the
 * timeframes together outrank one candle, a confirmed state outranks a shape.
 * The result carries the count both ways and the reasons behind it, so the
 * card can show its working rather than a number from nowhere.
 *
 * **It is not a probability, and nothing here rounds it into one.** A strength
 * of 70 means seven tenths of the weight pointed one way just now -- not that
 * it goes that way seven times in ten. That number needs the matched-state
 * history and a calibration pass; see docs/MARKET-STATE.md.
 */

export type BiasSide = 'UP' | 'DOWN' | 'NEUTRAL';

export type BiasRead = {
  side: BiasSide;
  /** How lopsided the vote was, 0-100. Not a probability. */
  strength: number;
  /** Weight each way, so "60" can be read as what it is. */
  up: number;
  down: number;
  /** The few reasons that carried the most weight, strongest first. */
  reasons: { text: string; side: Exclude<BiasSide, 'NEUTRAL'>; weight: number }[];
};

/**
 * What each kind of evidence is worth.
 *
 * A confirmed break is the market having done something; a candle shape is one
 * bar's opinion. The six timeframes agreeing is worth more than either. These
 * are the same proportions the state score uses, so the two cannot tell
 * different stories about the same tape.
 */
export const BIAS_WEIGHTS = {
  state: 3,
  structure: 2,
  candle: 1,
  indicator: 1,
  mtf: 3,
  flow: 2,
  regime: 1.5,
} as const;

/** Under this the vote is too close to call, and says so. */
export const NEUTRAL_BAND = 12;

export type BiasInput = {
  /** The state the desk called, and whether it is confirmed. */
  state: { side: Side | null; confirmed: boolean; event: string } | null;
  patterns: readonly Pattern[];
  indicators: readonly Indicator[];
  mtf: { up: number; down: number; total: number } | null;
  oiChangePct: number | null;
  cvdSlope: number | null;
  aggressorBuyPct: number | null;
  regime: 'TREND_UP' | 'TREND_DOWN' | 'RANGE' | 'QUIET' | null;
};

const sideOf = (b: PatternBias | Indicator['bias']): Exclude<BiasSide, 'NEUTRAL'> | null =>
  b === 'BULLISH' ? 'UP' : b === 'BEARISH' ? 'DOWN' : null;

export function biasFrom(input: BiasInput): BiasRead {
  const votes: { text: string; side: Exclude<BiasSide, 'NEUTRAL'>; weight: number }[] = [];
  const add = (side: Exclude<BiasSide, 'NEUTRAL'> | null, weight: number, text: string) => {
    if (side && weight > 0) votes.push({ side, weight, text });
  };

  // The state, which is the one thing here that is about what price did rather
  // than about what it looks like. An unconfirmed one counts for half.
  if (input.state?.side) {
    add(input.state.side, BIAS_WEIGHTS.state * (input.state.confirmed ? 1 : 0.5),
      `${input.state.event.toLowerCase().replaceAll('_', ' ')}`);
  }

  /*
   * Patterns, fading with age. A hammer three bars back is a fact about three
   * bars back; the same shape on the bar being formed is what is happening.
   */
  for (const p of input.patterns) {
    const base = p.kind === 'structure' ? BIAS_WEIGHTS.structure : BIAS_WEIGHTS.candle;
    const fade = Math.max(0.25, 1 - p.barsAgo * 0.2);
    add(sideOf(p.bias), base * fade, p.name);
  }

  for (const i of input.indicators) {
    if (i.value === null) continue;   // a reading that could not be taken votes for nobody
    add(sideOf(i.bias), BIAS_WEIGHTS.indicator, `${i.label} ${i.text}`);
  }

  // The timeframes, in proportion to how many agree: four of six is not six of six.
  if (input.mtf && input.mtf.total > 0) {
    const { up, down, total } = input.mtf;
    if (up !== down) {
      const share = Math.abs(up - down) / total;
      add(up > down ? 'UP' : 'DOWN', BIAS_WEIGHTS.mtf * share,
        `${Math.max(up, down)} of ${total} timeframes ${up > down ? 'up' : 'down'}`);
    }
  }

  // The tape and the board: who is crossing the spread, and whether positions
  // are being opened behind it.
  if (input.cvdSlope !== null && input.cvdSlope !== 0) {
    add(input.cvdSlope > 0 ? 'UP' : 'DOWN', BIAS_WEIGHTS.flow * 0.5,
      `CVD ${input.cvdSlope > 0 ? 'rising' : 'falling'}`);
  }
  if (input.aggressorBuyPct !== null && Math.abs(input.aggressorBuyPct - 50) >= 3) {
    add(input.aggressorBuyPct > 50 ? 'UP' : 'DOWN', BIAS_WEIGHTS.flow * 0.5,
      `${input.aggressorBuyPct.toFixed(0)}% of trades hitting the ${input.aggressorBuyPct > 50 ? 'offer' : 'bid'}`);
  }

  if (input.regime === 'TREND_UP') add('UP', BIAS_WEIGHTS.regime, 'trending up');
  if (input.regime === 'TREND_DOWN') add('DOWN', BIAS_WEIGHTS.regime, 'trending down');

  const up = votes.filter((v) => v.side === 'UP').reduce((a, v) => a + v.weight, 0);
  const down = votes.filter((v) => v.side === 'DOWN').reduce((a, v) => a + v.weight, 0);
  const total = up + down;
  const lean = total === 0 ? 0 : Math.round((Math.abs(up - down) / total) * 100);
  const side: BiasSide = total === 0 || lean < NEUTRAL_BAND ? 'NEUTRAL' : up > down ? 'UP' : 'DOWN';

  return {
    side,
    strength: lean,
    up: Math.round(up * 10) / 10,
    down: Math.round(down * 10) / 10,
    // The winning side's reasons: the losing side's are in the card's own list,
    // and a badge that argues with itself is a badge nobody reads.
    reasons: votes
      .filter((v) => side === 'NEUTRAL' || v.side === side)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 4),
  };
}
