import type { Candle } from '../market/delta.js';

/**
 * Where price is against the level that matters: breakout, rejection,
 * breakdown, or neither.
 *
 * The question a chart answers at a glance and a dashboard usually does not.
 * A screen full of numbers can say IV, OI, PCR and the RSI of six timeframes
 * and still not say the one thing the trader is looking at the chart for --
 * "it is pushing at 86,800; has it gone, or has it been turned back?"
 *
 * Pure: bars and readings go in, a state and its reasons come out. No clock, no
 * network, no database -- so every rule here is pinned by a test, and the same
 * inputs give the same answer on the screen, in a backtest and in the journal.
 *
 * Two things this is careful about, because both are how a detector like this
 * gets somebody hurt:
 *
 *   - **A candidate is not a confirmation.** A wick through a level is not a
 *     break. `stage` says which it is, and nothing reads CONFIRMED until the
 *     bar has closed through with the volume and the body to back it.
 *   - **A break that comes straight back is a rejection, not a break.** The
 *     false-breakout branch is checked before the breakout branch, because the
 *     cost of reading one as the other is the whole trade.
 */

// ------------------------------------------------------------------ the states

export type MarketEvent =
  | 'RANGE'
  | 'BREAKOUT_WATCH'
  | 'BREAKOUT_CANDIDATE'
  | 'BREAKOUT_CONFIRMED'
  | 'RETEST_HOLD'
  | 'FALSE_BREAKOUT'
  | 'REJECTION'
  | 'BREAKDOWN_WATCH'
  | 'BREAKDOWN_CANDIDATE'
  | 'BREAKDOWN_CONFIRMED'
  | 'FALSE_BREAKDOWN'
  | 'SUPPORT_REJECTION';

/**
 * How far along the same piece of news is.
 *
 * WATCH is "near the level", CANDIDATE is "through it but unproven",
 * CONFIRMED is "through it with the tape behind it", FAILED is "it went and
 * came back". The trader's question is which of these, not the long name.
 */
export type EventStage = 'RANGE' | 'WATCH' | 'CANDIDATE' | 'CONFIRMED' | 'RETEST' | 'FAILED';

export type Side = 'UP' | 'DOWN';

/** One line of the confirmation list on the card. `null` is "not measured". */
export type Check = { label: string; ok: boolean | null };

// ------------------------------------------------------------------ the inputs

/** The multi-timeframe vote, as `readMarket` already counts it. */
export type MtfVote = { up: number; down: number; total: number };

export type StateInput = {
  /**
   * The timeframe's bars, oldest first. The last one is the bar being formed;
   * everything measured "so far" is measured on it, and everything measured
   * "held" is measured on the one before.
   */
  bars: readonly Candle[];
  /** The level to judge against. Either may be null: that side is then not tested. */
  level: { resistance: number | null; support: number | null };
  /** Average true range in dollars, on this timeframe. Sizes the tolerance and the targets. */
  atr: number | null;
  /** The exchange's tick, for the floor under the tolerance. */
  tick?: number;
  /** Open interest over the same window, as a percentage. Positive is building. */
  oiChangePct?: number | null;
  /** Cumulative delta's slope: positive is buyers lifting offers. */
  cvdSlope?: number | null;
  /** Share of volume that crossed the spread to buy, 0-100. */
  aggressorBuyPct?: number | null;
  /** How the timeframes voted, for the alignment part of the score. */
  mtf?: MtfVote | null;
  /** The wider market, as `readMarket` reads it: a break with the trend scores higher. */
  regime?: Regime | null;
  /** What to call the timeframe in the sentence: "15m". */
  tfLabel?: string;
};

export type Regime = 'TREND_UP' | 'TREND_DOWN' | 'RANGE' | 'QUIET';

// ------------------------------------------------------------------ the output

export type MarketState = {
  event: MarketEvent;
  stage: EventStage;
  side: Side | null;
  /**
   * Whether this is a thing that has happened or a thing that might.
   *
   * The whole point of separating them: "BREAKOUT LIKELY 76%" is a setup and
   * "BREAKOUT CONFIRMED" is a fact, and a screen that says them in the same
   * voice teaches you to act on the first as though it were the second.
   */
  confirmed: boolean;
  level: { resistance: number | null; support: number | null };
  /** The level this state is about, and how far price is from it. */
  against: number | null;
  distance: number | null;
  /** 0-1, from the weights in `SCORE_WEIGHTS`. */
  score: number;
  /** The same number as a percentage, for the card. */
  confidence: number;
  parts: ScoreParts;
  checks: Check[];
  /** What the trade would be, if it is taken. Null while price is mid-range. */
  plan: Plan | null;
  /**
   * Both sides, always, whatever the state is.
   *
   * The card shows three columns at once -- go long over the level, wait
   * between them, go short under -- because the useful thing about a level is
   * that it is the same number whichever way price leaves it. `plan` is
   * whichever of these the current state points at, or null while it points at
   * neither.
   */
  plans: { up: Plan | null; down: Plan | null };
  volumeRatio: number | null;
  volumeRead: VolumeRead | null;
  /** One sentence, the way the card says it. */
  words: string;
  /**
   * The whole thing as one sentence, in the words somebody would say it in.
   *
   * Both branches, because both are live until one happens: what has to occur
   * for the break to count and where it goes if it does, then what it means if
   * it is refused instead. The card's top line is the state; this is the line
   * under it that a person can act on without reading the rest.
   */
  insight: string;
  /** Actionable execution guidance: whether to enter on close or wait for micro-retest */
  executionNote: string | null;
};

export type Plan = {
  side: Side;
  /** The level that has to give way, or hold. */
  trigger: number;
  target1: number;
  target2: number;
  /** Where the idea is wrong. */
  invalidation: number;
};

export type ScoreParts = {
  levelBreak: number;
  volume: number;
  candle: number;
  retest: number;
  flow: number;
  mtf: number;
  regime: number;
};

export type VolumeRead = 'WEAK' | 'NORMAL' | 'STRONG' | 'BURST';

// ------------------------------------------------------------------ the dials

/**
 * The weights, as one object rather than seven numbers in an expression.
 *
 * They sum to 1, and the test says so: a weight added without taking one away
 * silently rescales every score the desk has ever shown.
 */
export const SCORE_WEIGHTS = {
  levelBreak: 0.25,
  volume: 0.20,
  candle: 0.15,
  retest: 0.15,
  /** Open interest and cumulative delta together: who is behind the move. */
  flow: 0.10,
  mtf: 0.10,
  regime: 0.05,
} as const;

/** Busier than usual by this much, and the break has the tape behind it. */
export const VOLUME_CONFIRM = 1.5;
/** Body as a share of the bar's own range: under this it is mostly wick. */
export const BODY_RATIO = 0.55;
/** Where in its range the bar must close for the break to count. */
export const CLOSE_LOCATION = 0.70;
/** A body this fraction of the ATR or more is a bar that meant it. */
export const BODY_ATR = 0.3;
/** A wick this share of the range is the market refusing the level. */
export const WICK_SHARE = 0.4;
/** Crossing the spread this much one way is a side with its hand up. */
export const AGGRESSOR_PCT = 55;
/** Within this much of the level, in ATR, is close enough to watch. */
export const WATCH_ATR = 0.75;
/** How many bars the highest high and lowest low are taken over. */
export const LEVEL_BARS = 20;
/** How many bars the median volume is taken over. */
export const VOLUME_BARS = 20;

/**
 * How far past a level still counts as the level.
 *
 * A dollar through 86,800 is not a break, it is 86,800. The tolerance is a
 * tenth of the ATR, with a floor of five ticks so a quiet market cannot shrink
 * it to nothing -- and it is the single thing that decides how many false
 * breakouts this reports, so it is one number, used everywhere, not a constant
 * repeated at each comparison.
 */
export function toleranceFor(atr: number | null, tick = 0.5): number {
  return Math.max((atr ?? 0) * 0.10, tick * 5);
}

// ------------------------------------------------------------------ the levels

/**
 * The obvious level: the highest high and the lowest low of the last N bars.
 *
 * Deliberately the plainest definition there is. A swing-point level is better
 * when it is right and worse when it is not, and the one everybody can see on
 * the chart is the one everybody trades. `level` on the input accepts anything
 * better -- a swing from `readMarket`, an OI wall, the previous day's high --
 * and this is what fills it in when nothing better was passed.
 *
 * The bar being formed is left out on purpose: a level that includes the bar
 * you are testing against it can never be broken.
 */
export function levelsFrom(bars: readonly Candle[], n = LEVEL_BARS): { resistance: number | null; support: number | null } {
  const past = bars.slice(0, -1).slice(-n);
  if (past.length === 0) return { resistance: null, support: null };
  return {
    resistance: Math.max(...past.map((b) => b.high)),
    support: Math.min(...past.map((b) => b.low)),
  };
}

/**
 * How busy this bar is against the last twenty.
 *
 * The median, not the mean, for the reason `moves.ts` gives: one violent bar
 * drags a mean up far enough that the next violent bar stops looking unusual.
 */
export function volumeRatio(bars: readonly Candle[], n = VOLUME_BARS): number | null {
  const last = bars[bars.length - 1];
  if (!last) return null;
  const past = bars.slice(0, -1).slice(-n).map((b) => b.volume).filter((v) => v > 0).sort((a, b) => a - b);
  if (past.length < 5) return null;
  const mid = past.length >> 1;
  const median = past.length % 2 ? past[mid]! : (past[mid - 1]! + past[mid]!) / 2;
  return median > 0 ? last.volume / median : null;
}

export function volumeRead(ratio: number | null): VolumeRead | null {
  if (ratio === null) return null;
  if (ratio < 1) return 'WEAK';
  if (ratio < VOLUME_CONFIRM) return 'NORMAL';
  return ratio < 2 ? 'STRONG' : 'BURST';
}

/** Where in its own range the bar closed: 1 is on the high, 0 on the low. */
export function closeLocation(bar: Candle): number | null {
  const range = bar.high - bar.low;
  return range > 0 ? (bar.close - bar.low) / range : null;
}

/** The upper or lower wick as a share of the whole bar. */
export function wickShare(bar: Candle, side: Side): number | null {
  const range = bar.high - bar.low;
  if (!(range > 0)) return null;
  const body = Math.max(bar.open, bar.close);
  const under = Math.min(bar.open, bar.close);
  return side === 'UP' ? (bar.high - body) / range : (under - bar.low) / range;
}

/** The body against the ATR: how much of the bar is decision rather than noise. */
export function bodyStrength(bar: Candle, atr: number | null): number | null {
  if (!atr || atr <= 0) return null;
  return Math.abs(bar.close - bar.open) / atr;
}

/**
 * The body as a share of the bar's own range.
 *
 * The other half of "did this bar mean it". `bodyStrength` asks whether the
 * bar was big for this market; this asks whether the bar was body or wick. A
 * bar can be a full ATR tall and still be two wicks and an argument.
 */
export function bodyRatio(bar: Candle): number | null {
  const range = bar.high - bar.low;
  return range > 0 ? Math.abs(bar.close - bar.open) / range : null;
}

// ------------------------------------------------------------------ the detector

/**
 * The state machine, in the order the branches have to be checked.
 *
 * Order is the whole design here. A bar that closes back under a level it
 * closed above last bar is a false breakout *and* satisfies "close below
 * resistance", so the failure branches are asked first; a bar whose high is
 * through the level but whose close is not is a rejection, so that is asked
 * before the range branch, which would otherwise swallow it.
 */
export function marketState(input: StateInput): MarketState {
  const bars = input.bars;
  const bar = bars[bars.length - 1];
  const prev = bars[bars.length - 2] ?? null;
  const { resistance, support } = input.level.resistance === null && input.level.support === null
    ? levelsFrom(bars)
    : input.level;
  const atr = input.atr;
  const tol = toleranceFor(atr, input.tick);
  const ratio = volumeRatio(bars);
  const read = volumeRead(ratio);

  if (!bar) return quiet({ resistance, support }, ratio, read, 'No bars to read yet.');

  const brokeUp = resistance !== null && bar.close > resistance + tol;
  const brokeDown = support !== null && bar.close < support - tol;
  const pokedUp = resistance !== null && bar.high > resistance + tol && bar.close <= resistance + tol;
  const pokedDown = support !== null && bar.low < support - tol && bar.close >= support - tol;
  const heldAboveBefore = resistance !== null && prev !== null && prev.close > resistance + tol;
  const heldBelowBefore = support !== null && prev !== null && prev.close < support - tol;

  // ---- the failures first, for the reason in the doc comment above
  if (heldAboveBefore && resistance !== null && bar.close < resistance - tol) {
    return build('FALSE_BREAKOUT', 'FAILED', 'DOWN', resistance, false, input, bar, prev, ratio, read, tol,
      `Broke ${fmt(resistance)} and closed back under it: the break failed.`);
  }
  if (heldBelowBefore && support !== null && bar.close > support + tol) {
    return build('FALSE_BREAKDOWN', 'FAILED', 'UP', support, false, input, bar, prev, ratio, read, tol,
      `Lost ${fmt(support)} and reclaimed it: the breakdown failed.`);
  }

  // ---- through the level and still there
  if (brokeUp && resistance !== null) {
    // A second close above the level is the retest holding: the level was
    // given back to the market to test, and it held.
    const stage: EventStage = heldAboveBefore ? 'RETEST' : confirms(input, bar, ratio, atr, 'UP') ? 'CONFIRMED' : 'CANDIDATE';
    const event: MarketEvent = stage === 'RETEST' ? 'RETEST_HOLD'
      : stage === 'CONFIRMED' ? 'BREAKOUT_CONFIRMED' : 'BREAKOUT_CANDIDATE';
    return build(event, stage, 'UP', resistance, stage !== 'CANDIDATE', input, bar, prev, ratio, read, tol,
      stage === 'CANDIDATE'
        ? `Closed over ${fmt(resistance)} without the volume to back it: unconfirmed.`
        : `Closed over ${fmt(resistance)} and stayed: the level has gone.`);
  }
  if (brokeDown && support !== null) {
    const stage: EventStage = heldBelowBefore ? 'RETEST' : confirms(input, bar, ratio, atr, 'DOWN') ? 'CONFIRMED' : 'CANDIDATE';
    const event: MarketEvent = stage === 'RETEST' ? 'RETEST_HOLD'
      : stage === 'CONFIRMED' ? 'BREAKDOWN_CONFIRMED' : 'BREAKDOWN_CANDIDATE';
    return build(event, stage, 'DOWN', support, stage !== 'CANDIDATE', input, bar, prev, ratio, read, tol,
      stage === 'CANDIDATE'
        ? `Closed under ${fmt(support)} without the volume to back it: unconfirmed.`
        : `Closed under ${fmt(support)} and stayed: the level has gone.`);
  }

  // ---- touched and turned back
  if (pokedUp && resistance !== null) {
    return build('REJECTION', 'FAILED', 'DOWN', resistance, true, input, bar, prev, ratio, read, tol,
      `Tested ${fmt(resistance)} and closed back under it.`);
  }
  if (pokedDown && support !== null) {
    return build('SUPPORT_REJECTION', 'FAILED', 'UP', support, true, input, bar, prev, ratio, read, tol,
      `Tested ${fmt(support)} and closed back over it.`);
  }

  /*
   * Near enough to watch.
   *
   * Two rules, and the second is the one that keeps this honest. Within
   * three-quarters of an ATR of the level is "near"; but on a range narrower
   * than an ATR and a half that band reaches past the middle and would call
   * every bar in the range a watch, on both sides at once. So the nearer level
   * wins, and a bar sitting equally between them is what it looks like: a
   * range, with nothing to watch yet.
   */
  const watch = (atr ?? 0) * WATCH_ATR;
  const upAway = resistance === null ? null : resistance - bar.close;
  const downAway = support === null ? null : bar.close - support;
  const nearer = (a: number | null, b: number | null) => a !== null && a >= 0 && (b === null || a < b);
  if (resistance !== null && watch > 0 && upAway !== null && upAway <= watch && nearer(upAway, downAway)) {
    return build('BREAKOUT_WATCH', 'WATCH', 'UP', resistance, false, input, bar, prev, ratio, read, tol,
      `Price is near resistance. A close over ${fmt(resistance)} is the break.`);
  }
  if (support !== null && watch > 0 && downAway !== null && downAway <= watch && nearer(downAway, upAway)) {
    return build('BREAKDOWN_WATCH', 'WATCH', 'DOWN', support, false, input, bar, prev, ratio, read, tol,
      `Price is near support. A close under ${fmt(support)} is the break.`);
  }

  return build('RANGE', 'RANGE', null, null, false, input, bar, prev, ratio, read, tol,
    resistance !== null && support !== null
      ? `Between ${fmt(support)} and ${fmt(resistance)}: no break either way.`
      : 'No level near enough to trade against.');
}

/**
 * Everything a strong break needs beyond the close itself.
 *
 * Four gates, all of them: busier than usual, mostly body rather than wick,
 * big enough to matter against this market's own volatility, and closed at the
 * business end of its range. A bar that gave most of the move back before the
 * close is not a bar to follow, however far it reached.
 */
function confirms(input: StateInput, bar: Candle, ratio: number | null, atr: number | null, side: Side): boolean {
  const shape = bodyRatio(bar);
  const size = bodyStrength(bar, atr);
  const loc = closeLocation(bar);
  return ratio !== null && ratio >= VOLUME_CONFIRM
    && shape !== null && shape >= BODY_RATIO
    && (size === null || size >= BODY_ATR)
    && loc !== null && (side === 'UP' ? loc >= CLOSE_LOCATION : loc <= 1 - CLOSE_LOCATION);
}

// ------------------------------------------------------------------ the score

/**
 * One number for how much of the story agrees, by the weights above.
 *
 * Every part is 0 to 1 and a part that could not be measured scores zero
 * rather than being left out: a break with no flow data behind it is less
 * proven than one with the flow agreeing, and rescaling the weights to hide
 * the missing part would say the opposite.
 */
function scoreOf(input: StateInput, bar: Candle, ratio: number | null, side: Side | null, stage: EventStage): ScoreParts {
  const broke = stage === 'CONFIRMED' || stage === 'CANDIDATE' || stage === 'RETEST';
  const levelBreak = stage === 'RETEST' || stage === 'CONFIRMED' ? 1
    : stage === 'CANDIDATE' ? 0.6 : stage === 'WATCH' ? 0.3 : 0;

  const volume = ratio === null ? 0 : clamp01((ratio - 1) / (VOLUME_CONFIRM - 1) * 0.6 + (ratio >= VOLUME_CONFIRM ? 0.4 : 0));

  const dir = side ?? 'UP';
  const loc = closeLocation(bar);
  const located = loc === null ? 0 : dir === 'UP' ? loc : 1 - loc;
  const shape = bodyRatio(bar);
  const candle = shape === null ? located : clamp01(clamp01(shape / BODY_RATIO) * 0.5 + located * 0.5);

  /*
   * Open interest and cumulative delta as one part, because they answer one
   * question: who is behind the move. Price through a level with OI building
   * is new money taking the other side of it, which is the break that lasts;
   * price through with OI falling is the old side giving up, which is the
   * break that stops the moment they have finished. The aggressor split says
   * which side is paying the spread to make it happen.
   */
  const oiPct = input.oiChangePct ?? null;
  const oi = oiPct === null ? 0 : clamp01(oiPct / 3);
  const slope = input.cvdSlope ?? null;
  const buyPct = input.aggressorBuyPct ?? null;
  const cvdAgrees = slope !== null && (dir === 'UP' ? slope > 0 : slope < 0);
  const aggressorAgrees = buyPct !== null
    && (dir === 'UP' ? buyPct >= AGGRESSOR_PCT : 100 - buyPct >= AGGRESSOR_PCT);
  const flow = clamp01(oi * 0.4 + (cvdAgrees ? 0.3 : 0) + (aggressorAgrees ? 0.3 : 0));

  const vote = input.mtf ?? null;
  const mtf = !vote || vote.total <= 0 ? 0
    : clamp01((dir === 'UP' ? vote.up : vote.down) / vote.total);

  /*
   * The regime the break happens in. A break with the wider trend behind it is
   * worth more than the same break against it -- a counter-trend breakout is
   * the one that gets sold into -- and a break out of a quiet, compressed
   * market is worth more than one in a market already running.
   */
  const regime = input.regime == null ? 0
    : input.regime === (dir === 'UP' ? 'TREND_UP' : 'TREND_DOWN') ? 1
      : input.regime === 'QUIET' ? 0.6
        : input.regime === 'RANGE' ? 0.4 : 0;

  return {
    levelBreak,
    volume: broke || stage === 'WATCH' || stage === 'FAILED' ? volume : 0,
    candle,
    retest: stage === 'RETEST' ? 1 : 0,
    flow,
    mtf,
    regime,
  };
}

export const scoreFrom = (p: ScoreParts): number =>
  clamp01(
    SCORE_WEIGHTS.levelBreak * p.levelBreak
    + SCORE_WEIGHTS.volume * p.volume
    + SCORE_WEIGHTS.candle * p.candle
    + SCORE_WEIGHTS.retest * p.retest
    + SCORE_WEIGHTS.flow * p.flow
    + SCORE_WEIGHTS.mtf * p.mtf
    + SCORE_WEIGHTS.regime * p.regime,
  );

// ------------------------------------------------------------------ the plan

/**
 * Where it goes if it goes, and where the idea is wrong.
 *
 * Off the ATR rather than a round number of dollars, so the same rule reads
 * sensibly on a quiet afternoon and on a day BTC moves two thousand: one ATR
 * to the first target, two to the second, one back through the level to be
 * wrong. A level with no ATR behind it gets no plan rather than a made-up one.
 */
export function planFor(side: Side, level: number, atr: number | null): Plan | null {
  if (!atr || atr <= 0) return null;
  const sign = side === 'UP' ? 1 : -1;
  return {
    side,
    trigger: round(level),
    target1: round(level + sign * atr),
    target2: round(level + sign * atr * 2),
    invalidation: round(level - sign * atr),
  };
}

export function executionNoteFor(stage: EventStage, volumeRatio: number | null): string | null {
  if (stage === 'CONFIRMED') {
    return volumeRatio && volumeRatio >= 2.0
      ? 'Strong momentum (volume > 2x) · Direct entry favorable'
      : 'Confirmed on close · Wait for 1m micro-retest near level for optimal R:R';
  }
  if (stage === 'RETEST') {
    return 'Retest holding · Prime entry zone with tight invalidation';
  }
  if (stage === 'CANDIDATE') {
    return 'Unproven candle · Await completed close before entry';
  }
  if (stage === 'FAILED') {
    return 'Break refused · Counter-trend scalp only or wait for reclaim';
  }
  return null;
}

// ------------------------------------------------------------------ the card

function build(
  event: MarketEvent, stage: EventStage, side: Side | null, against: number | null, confirmed: boolean,
  input: StateInput, bar: Candle, _prev: Candle | null, ratio: number | null, read: VolumeRead | null,
  _tol: number, words: string,
): MarketState {
  const parts = scoreOf(input, bar, ratio, side, stage);
  const score = scoreFrom(parts);
  const { resistance, support } = input.level.resistance === null && input.level.support === null
    ? levelsFrom(input.bars)
    : input.level;
  const plans = {
    up: resistance === null ? null : planFor('UP', resistance, input.atr),
    down: support === null ? null : planFor('DOWN', support, input.atr),
  };
  return {
    event,
    stage,
    side,
    confirmed,
    level: { resistance, support },
    against,
    distance: against === null ? null : round(bar.close - against),
    score,
    confidence: Math.round(score * 100),
    parts,
    checks: checksFor(input, bar, ratio, side, stage),
    // A failed break's plan is the other way: that is the whole news in it.
    plan: side === null || against === null ? null : planFor(side, against, input.atr),
    plans,
    volumeRatio: ratio === null ? null : Math.round(ratio * 100) / 100,
    volumeRead: read,
    words,
    insight: insightFor(stage, side, plans, tfWords(input)),
    executionNote: executionNoteFor(stage, ratio),
  };
}

/** The timeframe in the sentence, when the caller named one. */
const tfWords = (input: StateInput) => input.tfLabel ?? 'this';

/**
 * The state as one sentence, with both branches in it.
 *
 * Written as a person would say it at the desk: what has to happen for the
 * break to count, where it goes if it does, and -- in the same breath -- what
 * it means if the level holds instead. Both halves matter while the bar is
 * still forming, and a sentence that gives only the side it currently favours
 * is the sentence that gets somebody caught on the other one.
 */
export function insightFor(
  stage: EventStage, side: Side | null,
  plans: { up: Plan | null; down: Plan | null },
  tf = 'this',
): string {
  const up = plans.up;
  const down = plans.down;
  if (!up && !down) return 'No level near enough to trade against yet.';

  const breakUp = up
    ? `If ${fmt(up.trigger)} breaks and a ${tf} candle closes above it with volume, `
      + `the next move is towards ${fmt(up.target1)} – ${fmt(up.target2)}.`
    : '';
  const breakDown = down
    ? `If ${fmt(down.trigger)} gives way on a close, ${fmt(down.target1)} – ${fmt(down.target2)} is next.`
    : '';

  switch (stage) {
    case 'CONFIRMED':
      return side === 'UP' && up
        ? `${fmt(up.trigger)} has gone on a close with volume behind it. `
          + `${fmt(up.target1)} then ${fmt(up.target2)}; it is wrong back under ${fmt(up.invalidation)}.`
        : down
          ? `${fmt(down.trigger)} has gone on a close with volume behind it. `
            + `${fmt(down.target1)} then ${fmt(down.target2)}; it is wrong back over ${fmt(down.invalidation)}.`
          : breakUp;
    case 'CANDIDATE':
      return side === 'UP' && up
        ? `Price closed over ${fmt(up.trigger)} but without the volume to prove it. `
          + `Another close above holds it towards ${fmt(up.target1)}; a close back under is a false break.`
        : down
          ? `Price closed under ${fmt(down.trigger)} but without the volume to prove it. `
            + `Another close below holds it towards ${fmt(down.target1)}; a close back over is a false break.`
          : breakDown;
    case 'RETEST':
      return side === 'UP' && up
        ? `${fmt(up.trigger)} was given back to the market and held. `
          + `That is the retest; ${fmt(up.target1)} – ${fmt(up.target2)} while it stays above.`
        : down
          ? `${fmt(down.trigger)} was retested from below and held. `
            + `${fmt(down.target1)} – ${fmt(down.target2)} while it stays under.`
          : breakUp;
    case 'FAILED':
      return side === 'DOWN' && down
        ? `The push was refused. Watch ${fmt(down.trigger)} for the short; `
          + `${fmt(down.target1)} – ${fmt(down.target2)} if it goes.`
        : up
          ? `The fall was refused and the level reclaimed. Watch ${fmt(up.trigger)} for the long; `
            + `${fmt(up.target1)} – ${fmt(up.target2)} if it goes.`
          : breakDown;
    default:
      // Range and watch: both branches, because neither has happened.
      return [breakUp, down ? `If it is rejected, watch ${fmt(down.trigger)} for the short.` : '']
        .filter(Boolean).join(' ');
  }
}

/** The tick list under the card: what has happened, what is still wanted. */
function checksFor(input: StateInput, bar: Candle, ratio: number | null, side: Side | null, stage: EventStage): Check[] {
  const dir = side ?? 'UP';
  const shape = bodyRatio(bar);
  const loc = closeLocation(bar);
  const buyPct = input.aggressorBuyPct ?? null;
  const slope = input.cvdSlope ?? null;
  const vote = input.mtf ?? null;
  const level = dir === 'UP' ? input.level.resistance : input.level.support;
  return [
    {
      label: level === null ? 'A level to trade against' : `Close ${dir === 'UP' ? 'over' : 'under'} ${fmt(level)}`,
      ok: stage === 'CONFIRMED' || stage === 'CANDIDATE' || stage === 'RETEST',
    },
    { label: `Volume over ${VOLUME_CONFIRM}x`, ok: ratio === null ? null : ratio >= VOLUME_CONFIRM },
    { label: `Body over ${Math.round(BODY_RATIO * 100)}% of the bar`, ok: shape === null ? null : shape >= BODY_RATIO },
    {
      label: dir === 'UP' ? 'Closed at the top of its range' : 'Closed at the bottom of its range',
      ok: loc === null ? null : dir === 'UP' ? loc >= CLOSE_LOCATION : loc <= 1 - CLOSE_LOCATION,
    },
    { label: 'Open interest building', ok: input.oiChangePct == null ? null : input.oiChangePct > 0 },
    {
      label: dir === 'UP' ? 'Buyers crossing the spread' : 'Sellers crossing the spread',
      ok: buyPct === null && slope === null ? null
        : (slope !== null && (dir === 'UP' ? slope > 0 : slope < 0))
          || (buyPct !== null && (dir === 'UP' ? buyPct >= AGGRESSOR_PCT : 100 - buyPct >= AGGRESSOR_PCT)),
    },
    {
      label: 'Timeframes agree',
      ok: !vote || vote.total <= 0 ? null : (dir === 'UP' ? vote.up : vote.down) * 2 > vote.total,
    },
    { label: 'Retest held', ok: stage === 'RETEST' },
  ];
}

function quiet(
  level: { resistance: number | null; support: number | null },
  ratio: number | null, read: VolumeRead | null, words: string,
): MarketState {
  return {
    event: 'RANGE', stage: 'RANGE', side: null, confirmed: false, level, against: null, distance: null,
    score: 0, confidence: 0,
    parts: { levelBreak: 0, volume: 0, candle: 0, retest: 0, flow: 0, mtf: 0, regime: 0 },
    checks: [], plan: null, plans: { up: null, down: null }, volumeRatio: ratio, volumeRead: read, words,
    insight: 'No level near enough to trade against yet.',
    executionNote: null,
  };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const round = (v: number) => Math.round(v * 10) / 10;
const fmt = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 0 });
