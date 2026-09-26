import type { TimeframeRead, Timeframe } from '../market/moves.js';

/**
 * The multi-timeframe hierarchy the Live screen decides with.
 *
 * `docs/New.md` sets it out: each timeframe has a *job*, and the jobs are not
 * interchangeable. 12H and 6H say where the market is going; 4H and 2H say
 * which prices matter; 1H and 30M say what is forming; 15M says whether the
 * pattern confirmed; 5M is the trigger; 1M is execution only.
 *
 * The rule that makes it worth building is the one New.md states as the wrong
 * approach to avoid:
 *
 *   > 1D UP / 4H DOWN / 1H DOWN / 15M UP / 5M UP -- எல்லாவற்றையும் equal vote
 *   > பண்ணுவது. … 1M bullish candle வந்ததுக்காக 12H bearish bias flip ஆகக்கூடாது.
 *
 * The screen's previous consensus did exactly that: `mtfConsensus` in
 * `lib/overview.ts` counted one vote per readable row and took a flat
 * majority, so five noisy fast frames outvoted the four slow ones that
 * actually set the direction. Here every frame carries the weight of its job,
 * and **1M carries none** -- it is reported so the entry can be timed, and it
 * is excluded from the sum by construction, not by a threshold that could be
 * tuned until it leaked back in.
 *
 * Nothing in this file does I/O or reads a clock. It is a pure function of the
 * reads handed to it, which is what lets the whole ladder be built by hand in
 * a test.
 */

/** What a frame is *for*. The tier decides the weight; the weight decides the bias. */
export type Tier = 'direction' | 'structure' | 'setup' | 'pattern' | 'trigger' | 'execution';

export type Way = 'UP' | 'DOWN' | 'SIDE';

/**
 * Which tier each frame belongs to.
 *
 * 1D is present because the venue serves it and the old screen showed it, but
 * it sits in `direction` beside 12H rather than above it: the desk's contract
 * expires in hours, and a daily bar that turned this morning is not more
 * informative about 17:30 today than the 12-hour one.
 */
export const TIER_OF: Record<Timeframe, Tier> = {
  '1d': 'direction',
  '12h': 'direction',
  '6h': 'direction',
  '4h': 'structure',
  '2h': 'structure',
  '1h': 'setup',
  '30m': 'setup',
  '15m': 'pattern',
  '5m': 'trigger',
  '1m': 'execution',
};

/**
 * The weight of one frame's vote, by tier.
 *
 * Read these as ratios, not as anything measured -- they encode New.md's
 * ordering (direction and structure HIGH, setup MEDIUM-HIGH, pattern and
 * trigger HIGH, execution none) and nothing more. They are exported so the
 * screen can print them beside the table: a weight nobody can see is a weight
 * nobody can argue with.
 *
 * `execution` is 0. That is the whole point of the file.
 */
export const TIER_WEIGHT: Record<Tier, number> = {
  direction: 3,
  structure: 3,
  setup: 2,
  pattern: 3,
  trigger: 3,
  execution: 0,
};

/** Human order, coarsest first -- the order the ladder is drawn in. */
export const TIER_ORDER: readonly Tier[] = ['direction', 'structure', 'setup', 'pattern', 'trigger', 'execution'];

export type Row = {
  tf: Timeframe;
  tier: Tier;
  weight: number;
  /** The EMA stack: -1 falling, 0 flat, +1 rising. */
  trend: -1 | 0 | 1;
  /** RSI(14) above 55 / below 45, else neutral. Null when the frame is too short to read. */
  momentum: 'bullish' | 'bearish' | 'neutral' | null;
  /** Swing structure: HH/HL, LH/LL, or neither. */
  structure: -1 | 0 | 1;
  /** Price against this frame's VWAP, in percent. */
  vwapDistPct: number | null;
  /** ADX(14) -- how strong, saying nothing about which way. */
  adx: number | null;
  /** This frame's own verdict, before weighting. */
  way: Way;
  /**
   * How firmly this frame holds its verdict, 0..1: the share of its own
   * sub-votes that agreed. A frame at 0.33 is one indicator out of three, and
   * it contributes a third of its weight.
   */
  conviction: number;
};

export type Ladder = {
  rows: Row[];
  /** Each tier's own verdict, from the frames in it. Absent when no frame in that tier is readable. */
  tiers: Partial<Record<Tier, Way>>;
  /** The weighted sum, signed. Positive is up. Execution contributes nothing. */
  score: number;
  /** `score` divided by the total weight that voted: -1..+1, comparable across days. */
  normalised: number;
  /** The overall read. SIDE when the weighted score is inside the dead band. */
  bias: Way;
  /** How much of the voting weight agreed with `bias`, 0..1. */
  alignment: number;
  /** "6 of 8 frames · 17 of 20 weight" -- what the header says under the arrow. */
  text: string;
  /** Frames that disagree with `bias`, coarsest first. The honest part of the read. */
  against: Timeframe[];
};

/**
 * Inside this band the weighted read is SIDE rather than a weak direction.
 *
 * A dead band is not tuning: without one, a score of +0.01 prints UP and the
 * screen says "go" on a market doing nothing. 0.15 of the available weight is
 * roughly "one high-weight frame, half-convinced".
 */
export const DEAD_BAND = 0.15;

/** ADX below this is a market with no trend to be on the right side of. */
export const ADX_TRENDING = 20;

function wayOfRow(r: TimeframeRead): { way: Way; conviction: number } {
  /*
   * Three reads per frame, each answering the same question a different way:
   * where the EMA stack points, where momentum sits, and whether the swings
   * are making higher highs or lower lows. VWAP joins as a fourth only when
   * price is a clear distance from it -- inside 0.1% it is noise, and a
   * tie-breaker made of noise is worse than no tie-breaker.
   */
  const votes: number[] = [
    r.trend,
    r.rsi14 === null ? 0 : r.rsi14 >= 55 ? 1 : r.rsi14 <= 45 ? -1 : 0,
    r.structure,
  ];
  if (r.vwapDistPct !== null && Math.abs(r.vwapDistPct) >= 0.1) votes.push(r.vwapDistPct > 0 ? 1 : -1);

  const sum = votes.reduce((a, b) => a + b, 0);
  const agreed = votes.filter((v) => v !== 0 && Math.sign(v) === Math.sign(sum)).length;
  const conviction = votes.length === 0 ? 0 : agreed / votes.length;
  return { way: sum > 0 ? 'UP' : sum < 0 ? 'DOWN' : 'SIDE', conviction: sum === 0 ? 0 : conviction };
}

/**
 * Build the ladder from the frames that could be read.
 *
 * A frame with too few bars is simply absent -- not counted as SIDE, which
 * would be a vote for "no direction" that nobody cast.
 */
export function ladder(reads: readonly TimeframeRead[]): Ladder {
  const rows: Row[] = reads
    .filter((r) => TIER_OF[r.tf] !== undefined)
    .map((r) => {
      const tier = TIER_OF[r.tf];
      const { way, conviction } = wayOfRow(r);
      return {
        tf: r.tf,
        tier,
        weight: TIER_WEIGHT[tier],
        trend: r.trend,
        momentum: r.rsi14 === null ? null : r.rsi14 >= 55 ? 'bullish' : r.rsi14 <= 45 ? 'bearish' : 'neutral',
        structure: r.structure,
        vwapDistPct: r.vwapDistPct,
        adx: r.adx14,
        way,
        conviction,
      } satisfies Row;
    })
    .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));

  // Only frames that carry weight and actually picked a side move the score.
  const voting = rows.filter((r) => r.weight > 0 && r.way !== 'SIDE');
  const totalWeight = rows.filter((r) => r.weight > 0).reduce((a, r) => a + r.weight, 0);
  const score = voting.reduce((a, r) => a + r.weight * r.conviction * (r.way === 'UP' ? 1 : -1), 0);
  const normalised = totalWeight === 0 ? 0 : score / totalWeight;
  const bias: Way = normalised > DEAD_BAND ? 'UP' : normalised < -DEAD_BAND ? 'DOWN' : 'SIDE';

  const tiers: Partial<Record<Tier, Way>> = {};
  for (const tier of TIER_ORDER) {
    const list = rows.filter((r) => r.tier === tier);
    if (!list.length) continue;
    const up = list.filter((r) => r.way === 'UP').length;
    const down = list.filter((r) => r.way === 'DOWN').length;
    tiers[tier] = up > down ? 'UP' : down > up ? 'DOWN' : 'SIDE';
  }

  const withBias = bias === 'SIDE' ? [] : voting.filter((r) => r.way === bias);
  const agreedWeight = withBias.reduce((a, r) => a + r.weight, 0);
  const alignment = totalWeight === 0 ? 0 : agreedWeight / totalWeight;
  const against = bias === 'SIDE' ? [] : voting.filter((r) => r.way !== bias).map((r) => r.tf);

  const counted = rows.filter((r) => r.weight > 0).length;
  const text = counted === 0
    ? 'no timeframe readable'
    : bias === 'SIDE'
      ? `no side: ${Math.round(Math.abs(normalised) * 100)}% of weight, inside the ${Math.round(DEAD_BAND * 100)}% band`
      : `${withBias.length} of ${counted} frames · ${agreedWeight} of ${totalWeight} weight`;

  return { rows, tiers, score, normalised, bias, alignment, text, against };
}

/**
 * Does the ladder allow a trade, and in which direction?
 *
 * New.md's example -- 12H DOWN, 6H DOWN, 4H DOWN, 1H DOWN, 30M lower high,
 * 15M resistance rejection, 5M breakdown confirmed -- is the shape this looks
 * for, but expressed as a rule rather than a list: the direction tier and the
 * trigger tier must agree, and the structure tier must not contradict them.
 *
 * Deliberately NOT a score threshold. A single number crossing a line is how a
 * screen ends up saying ENTRY READY because four fast frames lined up under a
 * daily downtrend.
 */
export type Readiness = {
  ready: boolean;
  side: 'UP' | 'DOWN' | null;
  /** Every reason it is not ready, in the order a person would check them. */
  blockers: string[];
};

export function readiness(l: Ladder): Readiness {
  const blockers: string[] = [];
  const dir = l.tiers.direction ?? null;
  const trig = l.tiers.trigger ?? null;
  const struct = l.tiers.structure ?? null;

  if (dir === null) blockers.push('No direction frame readable (12H / 6H / 1D)');
  else if (dir === 'SIDE') blockers.push('Direction frames disagree — 12H and 6H are not pointing the same way');

  if (trig === null) blockers.push('No 5M trigger frame readable');
  else if (dir !== null && dir !== 'SIDE' && trig !== dir) {
    blockers.push(`5M trigger is ${trig}, direction is ${dir} — wait for the trigger to turn`);
  }

  if (struct !== null && dir !== null && dir !== 'SIDE' && struct !== 'SIDE' && struct !== dir) {
    blockers.push(`4H / 2H structure is ${struct} against a ${dir} direction`);
  }

  if (l.bias === 'SIDE') blockers.push(`Weighted read is inside the ${Math.round(DEAD_BAND * 100)}% dead band`);

  // A market with no trend anywhere is one where every level is a coin flip.
  const trending = l.rows.filter((r) => r.weight > 0 && r.adx !== null && r.adx >= ADX_TRENDING).length;
  if (trending === 0 && l.rows.some((r) => r.adx !== null)) blockers.push(`No frame has ADX ≥ ${ADX_TRENDING} — nothing is trending`);

  const side = dir === 'UP' || dir === 'DOWN' ? dir : null;
  return { ready: blockers.length === 0 && side !== null, side, blockers };
}
