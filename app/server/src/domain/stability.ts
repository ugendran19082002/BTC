/**
 * Can the reader trust the signal on the screen right now?
 *
 * `docs/New.md` §31 calls this "ரொம்ப முக்கியமான missing category" — a very
 * important missing category — and §32 asks for the UI to be able to say
 * `⚠ LOW SIGNAL STABILITY`. It is the question every other number on the screen
 * assumes has been answered.
 *
 * The distinction that makes it worth computing: a signal can be **correct and
 * useless**. A read that says UP, then DOWN, then UP, then SIDE over twenty
 * minutes is not giving a direction, it is giving noise with a label on it, and
 * each individual read may be exactly what the rules say. New.md's own example:
 *
 *   UP UP UP SIDE UP   → stable
 *   UP DOWN UP DOWN SIDE → unstable
 *
 * So stability is measured over the *journal*, which is the only record of what
 * the screen actually said, rather than over anything recomputed now. Two
 * numbers come out of it:
 *
 *  - **flips**: how many times the side changed between consecutive calls.
 *  - **persistence**: the share of calls that agreed with the most common side.
 *
 * And one word, because a number nobody can act on is a number nobody reads.
 *
 * Pure. No clock, no I/O — the rows and `now` arrive as arguments, so every case
 * below can be built by hand.
 */

export type Verdict = 'STABLE' | 'CHOPPY' | 'UNSTABLE' | 'TOO_FEW';

/** One journalled call, reduced to what stability cares about. */
export type Call = {
  at: number;
  /** The side the call took. `null` for a range/no-side call, which is not a flip. */
  side: 'UP' | 'DOWN' | null;
};

export type Stability = {
  verdict: Verdict;
  /** Calls considered — inside the window, newest first. */
  n: number;
  /** Side changes between consecutive calls. UP→SIDE→UP counts as none. */
  flips: number;
  /** 0..1 — the share of sided calls that agreed with the majority side. 1 is one-directional. */
  persistence: number;
  /** The side that dominated, or null when they cancelled out. */
  leaning: 'UP' | 'DOWN' | null;
  /** How long the newest call has stood, ms. Null with no calls. */
  ageMs: number | null;
  /** One sentence a person can act on. */
  text: string;
};

/** How far back stability is measured. Beyond this a flip is history, not noise. */
export const WINDOW_MS = 60 * 60_000;

/** Below this many sided calls there is nothing to be stable about. */
export const MIN_CALLS = 3;

/** At or above this share agreeing, the read is holding its direction. */
export const STABLE_PERSISTENCE = 0.8;

/** Two flips inside the window is already a read that cannot be traded. */
export const UNSTABLE_FLIPS = 3;

/**
 * A side change between consecutive *sided* calls.
 *
 * `UP → SIDE → UP` is deliberately not a flip: a range call between two
 * up-calls is the market pausing, not the read reversing, and counting it would
 * make every quiet hour look unstable.
 */
function countFlips(sides: readonly ('UP' | 'DOWN')[]): number {
  let flips = 0;
  for (let i = 1; i < sides.length; i++) if (sides[i] !== sides[i - 1]) flips++;
  return flips;
}

export function stabilityOf(calls: readonly Call[], now: number, windowMs = WINDOW_MS): Stability {
  const recent = calls
    .filter((c) => now - c.at <= windowMs && now >= c.at)
    .sort((a, b) => b.at - a.at);

  const newest = recent[0] ?? null;
  const ageMs = newest ? now - newest.at : null;

  // Oldest first, so a flip is read in the order it happened.
  const sides = [...recent].reverse().map((c) => c.side).filter((s): s is 'UP' | 'DOWN' => s !== null);

  if (sides.length < MIN_CALLS) {
    return {
      verdict: 'TOO_FEW',
      n: recent.length,
      flips: 0,
      persistence: 0,
      leaning: null,
      ageMs,
      text: recent.length === 0
        ? 'No calls in the last hour — nothing to judge stability on.'
        : `Only ${sides.length} sided call${sides.length === 1 ? '' : 's'} in the last hour; too few to call the read stable or not.`,
    };
  }

  const up = sides.filter((s) => s === 'UP').length;
  const down = sides.length - up;
  const majority = Math.max(up, down);
  const persistence = majority / sides.length;
  const leaning = up === down ? null : up > down ? 'UP' : 'DOWN';
  const flips = countFlips(sides);

  const verdict: Verdict = flips >= UNSTABLE_FLIPS
    ? 'UNSTABLE'
    : persistence >= STABLE_PERSISTENCE && flips <= 1 ? 'STABLE' : 'CHOPPY';

  const text = verdict === 'UNSTABLE'
    ? `The read changed side ${flips} times in the last hour. That is noise with a direction printed on it — do not size a trade off it.`
    : verdict === 'STABLE'
      ? `${majority} of ${sides.length} calls in the last hour agreed on ${leaning ?? 'one side'}. The read is holding.`
      : `${majority} of ${sides.length} calls agreed, with ${flips} change${flips === 1 ? '' : 's'} of side. The read is mixed — treat its direction as weak.`;

  return { verdict, n: recent.length, flips, persistence, leaning, ageMs, text };
}

/**
 * Reasons the screen's confidence should be read *down*, in plain words.
 *
 * `docs/New.md` §33 asks for exactly this: a stale feed, a multi-timeframe
 * conflict, a regime transition, thin volume or a wide spread should all lower
 * the confidence rather than being noted somewhere and forgotten.
 *
 * Kept separate from `readiness.blockers` on purpose, because they answer
 * different questions. A blocker says **you may not act**; a penalty says **you
 * may act, but this number is worth less than it looks**. Merging them turns a
 * hard rule into a suggestion, which is how a gate quietly stops gating.
 */
export type Penalty = { reason: string; detail: string };

export function penaltiesFor(input: {
  /** Frames disagreeing with the weighted read. */
  against: readonly string[];
  /** Where the price came from — a candle close is a stale mark. */
  spotFrom: 'ticker' | 'candle-close';
  /** Rows the screen wanted and did not get. */
  missing: readonly string[];
  /** The stability read, when there is one. */
  stability: Stability | null;
  /** Strongest ADX across the weighted frames, when known. */
  maxAdx: number | null;
  /** ADX below which nothing is trending. */
  adxFloor: number;
}): Penalty[] {
  const out: Penalty[] = [];

  if (input.spotFrom === 'candle-close') {
    out.push({
      reason: 'Stale price',
      detail: 'No live tick — every distance on this screen is measured from the last 5-minute close and may be minutes behind.',
    });
  }

  if (input.against.length > 0) {
    out.push({
      reason: 'Timeframes disagree',
      detail: `${input.against.join(', ')} ${input.against.length === 1 ? 'points' : 'point'} the other way. `
        + 'The weighted read still has a side, but it is carrying a dissent.',
    });
  }

  if (input.maxAdx !== null && input.maxAdx < input.adxFloor) {
    out.push({
      reason: 'Nothing is trending',
      detail: `The strongest ADX across the weighted frames is ${input.maxAdx.toFixed(0)}, under ${input.adxFloor}. `
        + 'In a market with no trend, every level is close to a coin flip.',
    });
  }

  if (input.stability && input.stability.verdict === 'UNSTABLE') {
    out.push({ reason: 'Low signal stability', detail: input.stability.text });
  } else if (input.stability && input.stability.verdict === 'CHOPPY') {
    out.push({ reason: 'Mixed signal', detail: input.stability.text });
  }

  if (input.missing.length > 0) {
    out.push({
      reason: 'Incomplete read',
      detail: `${input.missing.length} thing${input.missing.length === 1 ? '' : 's'} the screen wanted could not be read. See "Not read" below.`,
    });
  }

  return out;
}
