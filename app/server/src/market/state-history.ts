import { migrate, type Migration } from '../db/migrate.js';
import { one, query, rows } from '../db/pool.js';
import { candles, type Candle } from './delta.js';
import type { MarketEvent, Plan, Side } from '../domain/market-state.js';
import { STATE_TF_MINUTES, type StateRead, type StateTf } from './state-read.js';

/**
 * Every state the desk has called, and whether it was right.
 *
 * The point is not the list. It is that a card which says "76%" every few
 * minutes has to be answerable for it, and the only honest answer is what
 * happened next -- so each call is written down when it is made, and graded
 * later against the bars that followed, by a rule fixed before the outcome was
 * known.
 *
 * Written on change only. The state is read every time somebody opens the
 * screen, and a row per poll would be a journal of how often the page was
 * looked at rather than of what the market did.
 */

export const MARKET_STATES_KEEP_MS = 90 * 24 * 3_600_000;

/** How many bars of its own timeframe a call is given to come good. */
export const GRADE_BARS = 4;

/**
 * How long a call is given, per timeframe.
 *
 * Four bars is right for a five-minute chart and far too short for an hourly
 * one: an hourly setup that needs an afternoon was being marked done in four
 * hours. The windows are the owner's (24 Sep 2026) -- long enough for the move
 * the timeframe is about, short enough that the journal is not full of calls
 * still waiting a week later.
 */
export const EVAL_WINDOW_MIN: Record<string, number> = {
  '5m': 30, '15m': 90, '30m': 120, '1h': 240, '2h': 480, '4h': 720,
};

export const windowMsFor = (tf: string): number =>
  (EVAL_WINDOW_MIN[tf] ?? STATE_TF_MINUTES[tf as StateTf] * GRADE_BARS) * 60_000;

const MIGRATIONS: Migration[] = [
  {
    /*
     * The journal behind the "AI signal history" list, and behind any honest
     * answer to "is this thing any good?". Retention is 90 days, which is long
     * enough to measure a hit rate and short enough that nobody has to think
     * about the size of it.
     */
    id: 'market-010-market-states',
    up: `
      CREATE TABLE IF NOT EXISTS market_states (
        id           BIGSERIAL PRIMARY KEY,
        at           BIGINT           NOT NULL,
        tf           TEXT             NOT NULL,
        event        TEXT             NOT NULL,
        stage        TEXT             NOT NULL,
        side         TEXT,
        confirmed    BOOLEAN          NOT NULL,
        confidence   INTEGER          NOT NULL,
        close        DOUBLE PRECISION NOT NULL,
        resistance   DOUBLE PRECISION,
        support      DOUBLE PRECISION,
        trigger      DOUBLE PRECISION,
        target1      DOUBLE PRECISION,
        target2      DOUBLE PRECISION,
        invalidation DOUBLE PRECISION,
        outcome      TEXT,
        graded_at    BIGINT
      );
      CREATE INDEX IF NOT EXISTS market_states_tf_at ON market_states (tf, at DESC);
      CREATE INDEX IF NOT EXISTS market_states_ungraded ON market_states (at) WHERE outcome IS NULL;
    `,
  },
  {
    /*
     * The rest of what the card said, kept with the call it belongs to.
     *
     * The first version wrote the verdict and the levels and nothing else, so
     * a row could say a breakout was called at 76 but not what the 76 was made
     * of, what the bars looked like, or where price actually went. That is
     * enough to list the calls and not enough to answer the only question
     * worth asking of them -- which of these readings ever paid -- and the
     * inputs cannot be reconstructed afterwards from bars alone.
     *
     * The measured columns are their own; the several-of-a-kind ones are JSONB
     * because their shape is the engine's and will move with it, and a column
     * per indicator would be a migration every time one is added.
     */
    id: 'market-011-state-detail',
    up: `
      ALTER TABLE market_states
        ADD COLUMN IF NOT EXISTS words          TEXT,
        ADD COLUMN IF NOT EXISTS insight        TEXT,
        ADD COLUMN IF NOT EXISTS volume_ratio   DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS atr            DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS parts          JSONB,
        ADD COLUMN IF NOT EXISTS inputs         JSONB,
        ADD COLUMN IF NOT EXISTS patterns       JSONB,
        ADD COLUMN IF NOT EXISTS indicators     JSONB,
        ADD COLUMN IF NOT EXISTS resolved_close DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS move_pts       DOUBLE PRECISION;
    `,
  },
  {
    /*
     * Full signal lifecycle audit trail: exactly when the trigger was breached,
     * whether first hit was target or stop and at what price and timestamp,
     * plus maximum favorable/adverse excursion (MFE / MAE) and context.
     */
    id: 'market-015-signal-lifecycle-audit',
    up: `
      ALTER TABLE market_states
        ADD COLUMN IF NOT EXISTS triggered_at    BIGINT,
        ADD COLUMN IF NOT EXISTS confirmed_at    BIGINT,
        ADD COLUMN IF NOT EXISTS target_hit_at   BIGINT,
        ADD COLUMN IF NOT EXISTS stop_hit_at     BIGINT,
        ADD COLUMN IF NOT EXISTS expired_at      BIGINT,
        ADD COLUMN IF NOT EXISTS first_hit       TEXT,
        ADD COLUMN IF NOT EXISTS first_hit_price DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS first_hit_time  BIGINT,
        ADD COLUMN IF NOT EXISTS mfe             DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS mae             DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS mfe_price       DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS mae_price       DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS eval_window_min INTEGER,
        ADD COLUMN IF NOT EXISTS score           INTEGER,
        ADD COLUMN IF NOT EXISTS probability     INTEGER,
        ADD COLUMN IF NOT EXISTS regime          TEXT,
        ADD COLUMN IF NOT EXISTS mtf_consensus   TEXT;
    `,
  },
];

let ready: Promise<void> | null = null;
export function stateHistorySchema(): Promise<void> {
  if (ready) return ready;
  ready = migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

/**
 * What became of a call, in the words of what actually happened.
 *
 * It used to be CORRECT / WRONG / UNRESOLVED, and **WRONG was a lie most of
 * the time it appeared**. A breakout watch says "over 84,532 this goes to
 * 84,731" -- if price never reached 84,532 the setup never happened, and
 * marking it wrong grades a trade nobody could have taken. The screen filled
 * with red for calls that were never anything but a plan.
 *
 * So a call now ends where it actually ended:
 *
 * * `NOT_TRIGGERED` -- the trigger was never reached. Nothing happened. This
 *   is not a failure and is never shown as one.
 * * `TARGET_HIT` -- triggered, and the first target came before the stop.
 * * `INVALIDATED` -- triggered, and the invalidation came first. A bar that
 *   reached both counts here: the order is not in the bar, and the assumption
 *   against the call is the only one that cannot flatter it.
 * * `EXPIRED` -- triggered, and the window closed with neither reached. Price
 *   drifted. Counting that either way would be choosing an answer.
 * * `NOT_GRADED` -- a range. "Nothing is happening" is not a prediction.
 *
 * The word *wrong* belongs on a backtest page, after a window has closed, next
 * to what was predicted and what happened. It does not belong on a live screen
 * where most of what it marks has not finished yet.
 */
export type Outcome = 'TARGET_HIT' | 'INVALIDATED' | 'NOT_TRIGGERED' | 'EXPIRED' | 'NOT_GRADED';

/** The rows written before 24 Sep 2026 carry the old words. */
const OLD_OUTCOMES: Record<string, Outcome> = {
  CORRECT: 'TARGET_HIT', WRONG: 'INVALIDATED', UNRESOLVED: 'EXPIRED', NOT_GRADED: 'NOT_GRADED',
};
export const outcomeOf = (stored: string | null): Outcome | null =>
  stored === null ? null : OLD_OUTCOMES[stored] ?? (stored as Outcome);

export type StateRow = {
  id: number;
  at: number;
  tf: StateTf;
  event: MarketEvent;
  stage: string;
  side: Side | null;
  confirmed: boolean;
  confidence: number;
  close: number;
  plan: Plan | null;
  outcome: Outcome | null;
  gradedAt: number | null;
  /** The close of the last bar of the grading window, once it has been graded. */
  resolvedClose: number | null;
  /** BTC index points from the call to that close: the move, not the verdict. */
  movePts: number | null;
  triggeredAt?: number | null;
  confirmedAt?: number | null;
  targetHitAt?: number | null;
  stopHitAt?: number | null;
  expiredAt?: number | null;
  firstHit?: 'TARGET' | 'STOP' | 'NONE' | null;
  firstHitPrice?: number | null;
  firstHitTime?: number | null;
  mfe?: number | null;
  mae?: number | null;
  mfePrice?: number | null;
  maePrice?: number | null;
  evalWindowMin?: number | null;
  score?: number | null;
  probability?: number | null;
  regime?: string | null;
  mtfConsensus?: string | null;
};

export type SignalAudit = {
  outcome: Outcome;
  triggeredAt: number | null;
  confirmedAt: number | null;
  targetHitAt: number | null;
  stopHitAt: number | null;
  expiredAt: number | null;
  firstHit: 'TARGET' | 'STOP' | 'NONE';
  firstHitPrice: number | null;
  firstHitTime: number | null;
  mfe: number | null;
  mae: number | null;
  mfePrice: number | null;
  maePrice: number | null;
};

/**
 * Full intrabar audit evaluation of a signal over the bars following its call.
 *
 * Tracks the trigger moment, whether target or stop was hit first, the exact price
 * and timestamp of that first hit, and the maximum favorable and adverse excursion.
 */
export function evaluateSignalOutcome(input: {
  plan: Plan | null;
  side: Side | null;
  stage: string;
  callAt: number;
  closeAtCall: number;
  windowMs: number;
  after: readonly Candle[];
}): SignalAudit {
  const { plan, side, stage, callAt, closeAtCall, windowMs, after } = input;
  const defAudit: SignalAudit = {
    outcome: 'NOT_GRADED',
    triggeredAt: null,
    confirmedAt: null,
    targetHitAt: null,
    stopHitAt: null,
    expiredAt: null,
    firstHit: 'NONE',
    firstHitPrice: null,
    firstHitTime: null,
    mfe: null,
    mae: null,
    mfePrice: null,
    maePrice: null,
  };

  if (!plan || side === null) return defAudit;
  if (!after.length) {
    return { ...defAudit, outcome: 'EXPIRED', expiredAt: callAt + windowMs };
  }

  const through = (bar: Candle) => (side === 'UP' ? bar.high >= plan.trigger : bar.low <= plan.trigger);
  const alreadyThrough = stage === 'CONFIRMED' || stage === 'RETEST' || stage === 'FAILED';
  const from = alreadyThrough ? 0 : after.findIndex(through);

  if (from < 0) {
    return {
      ...defAudit,
      outcome: 'NOT_TRIGGERED',
      expiredAt: callAt + windowMs,
    };
  }

  const triggerBar = after[from]!;
  const triggeredAt = alreadyThrough ? callAt : triggerBar.time * 1000;
  const confirmedAt = (alreadyThrough || stage === 'CONFIRMED') ? callAt : null;
  const tradeBars = after.slice(from);
  const entryPrice = alreadyThrough ? closeAtCall : plan.trigger;

  let bestPrice = entryPrice;
  let worstPrice = entryPrice;
  let firstHit: 'TARGET' | 'STOP' | 'NONE' = 'NONE';
  let firstHitPrice: number | null = null;
  let firstHitTime: number | null = null;
  let targetHitAt: number | null = null;
  let stopHitAt: number | null = null;
  let outcome: Outcome = 'EXPIRED';

  for (const bar of tradeBars) {
    const barTimeMs = bar.time * 1000;
    if (side === 'UP') {
      if (bar.high > bestPrice) bestPrice = bar.high;
      if (bar.low < worstPrice) worstPrice = bar.low;
    } else {
      if (bar.low < bestPrice) bestPrice = bar.low;
      if (bar.high > worstPrice) worstPrice = bar.high;
    }

    const hitTarget = side === 'UP' ? bar.high >= plan.target1 : bar.low <= plan.target1;
    const hitStop = side === 'UP' ? bar.low <= plan.invalidation : bar.high >= plan.invalidation;

    if (firstHit === 'NONE') {
      if (hitStop && hitTarget) {
        firstHit = 'STOP';
        firstHitPrice = plan.invalidation;
        firstHitTime = barTimeMs;
        stopHitAt = barTimeMs;
        outcome = 'INVALIDATED';
      } else if (hitStop) {
        firstHit = 'STOP';
        firstHitPrice = plan.invalidation;
        firstHitTime = barTimeMs;
        stopHitAt = barTimeMs;
        outcome = 'INVALIDATED';
      } else if (hitTarget) {
        firstHit = 'TARGET';
        firstHitPrice = plan.target1;
        firstHitTime = barTimeMs;
        targetHitAt = barTimeMs;
        outcome = 'TARGET_HIT';
      }
    }
  }

  const expiredAt = outcome === 'EXPIRED' ? callAt + windowMs : null;
  const mfe = side === 'UP'
    ? Math.max(0, Math.round((bestPrice - entryPrice) * 100) / 100)
    : Math.max(0, Math.round((entryPrice - bestPrice) * 100) / 100);
  const mae = side === 'UP'
    ? Math.max(0, Math.round((entryPrice - worstPrice) * 100) / 100)
    : Math.max(0, Math.round((worstPrice - entryPrice) * 100) / 100);

  return {
    outcome,
    triggeredAt,
    confirmedAt,
    targetHitAt,
    stopHitAt,
    expiredAt,
    firstHit,
    firstHitPrice,
    firstHitTime,
    mfe,
    mae,
    mfePrice: bestPrice,
    maePrice: worstPrice,
  };
}

/**
 * What happened after the call, judged in the order it could have happened.
 *
 * The trigger comes first. A setup is a conditional -- over this price,
 * towards that one -- so the bars are read for the trigger before anything
 * else is asked. Until price reaches it there is no trade and no verdict.
 */
export function outcomeFor(input: {
  plan: Plan | null;
  side: Side | null;
  /** WATCH and CANDIDATE are setups; CONFIRMED and RETEST are already through. */
  stage: string;
  after: readonly Candle[];
}): Outcome {
  return evaluateSignalOutcome({
    plan: input.plan,
    side: input.side,
    stage: input.stage,
    callAt: 0,
    closeAtCall: input.plan?.trigger ?? 0,
    windowMs: 0,
    after: input.after,
  }).outcome;
}

/**
 * The words the card puts in the right-hand column.
 *
 * None of them is "wrong". A call that has not finished says so, a setup that
 * never triggered says that, and the only red word is for a call that actually
 * went against its own invalidation.
 */
export const outcomeWords = (o: Outcome | null): string =>
  o === 'TARGET_HIT' ? 'Target hit'
    : o === 'INVALIDATED' ? 'Invalidated'
      : o === 'NOT_TRIGGERED' ? 'Not triggered'
        : o === 'EXPIRED' ? 'Expired'
          : o === null ? 'Waiting'
            : '—';

/**
 * Write this state down, unless it is the same one the last row already says.
 *
 * Returns the row's id when something was written, and null when the state has
 * not moved. A state that comes back after something else in between is a new
 * row: it is a new call, made in a new place.
 */
export async function noteState(read: StateRead): Promise<number | null> {
  await stateHistorySchema();
  const last = await one<{ event: string; stage: string }>(
    'SELECT event, stage FROM market_states WHERE tf = $1 ORDER BY at DESC LIMIT 1', [read.tf],
  );
  const s = read.state;
  if (last && last.event === s.event && last.stage === s.stage) return null;
  const bar = read.bars[read.bars.length - 1] ?? null;
  /*
   * Everything the card showed, not just the verdict: the score's parts, what
   * it was measured against, the shapes named and the readings taken. Written
   * as it was at the moment of the call, because none of it can be worked out
   * again later from the bars.
   */
  const row = await one<{ id: number }>(
    `INSERT INTO market_states
       (at, tf, event, stage, side, confirmed, confidence, close, resistance, support,
        trigger, target1, target2, invalidation,
        words, insight, volume_ratio, atr, parts, inputs, patterns, indicators,
        confirmed_at, eval_window_min, score, probability, regime, mtf_consensus)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
             $15,$16,$17,$18,$19,$20,$21,$22,
             $23,$24,$25,$26,$27,$28)
     RETURNING id`,
    [
      read.at, read.tf, s.event, s.stage, s.side, s.confirmed, s.confidence, bar?.close ?? 0,
      s.level.resistance, s.level.support,
      s.plan?.trigger ?? null, s.plan?.target1 ?? null, s.plan?.target2 ?? null, s.plan?.invalidation ?? null,
      s.words, s.insight, s.volumeRatio, read.inputs.atr,
      JSON.stringify(s.parts), JSON.stringify(read.inputs),
      JSON.stringify(read.patterns.shown), JSON.stringify(read.indicators.shown),
      s.confirmed ? read.at : null,
      EVAL_WINDOW_MIN[read.tf] ?? 30,
      s.confidence,
      null,
      read.context?.regime ?? null,
      read.context?.alignment?.word ?? null,
    ],
  );
  await query('DELETE FROM market_states WHERE at < $1', [read.at - MARKET_STATES_KEEP_MS]);
  return row?.id ?? null;
}

/**
 * Grade whatever is old enough to be graded.
 *
 * One fetch of bars per row, and only for rows whose window has actually
 * closed -- grading a call whose bars have not happened yet would answer the
 * question with a shrug and then never ask it again.
 *
 * Oldest first, a call is graded the first pass after its bars exist.
 */
export async function gradeStates(nowMs = Date.now(), limit = 20): Promise<number> {
  await stateHistorySchema();
  const due = await rows<{
    id: number; at: number; tf: StateTf; side: Side | null; close: number; stage: string;
    trigger: number | null; target1: number | null; target2: number | null; invalidation: number | null;
  }>(
    `SELECT id, at, tf, side, close, stage, trigger, target1, target2, invalidation
       FROM market_states WHERE outcome IS NULL ORDER BY at ASC LIMIT $1`, [limit],
  );
  let graded = 0;
  for (const r of due) {
    const windowMs = windowMsFor(r.tf);
    if (nowMs < r.at + windowMs) continue;
    const plan: Plan | null = r.target1 === null || r.invalidation === null || r.side === null ? null : {
      side: r.side, trigger: r.trigger ?? 0, target1: r.target1, target2: r.target2 ?? r.target1,
      invalidation: r.invalidation,
    };
    // Fetched even for a range, which is not graded but still moved somewhere.
    const after = await candles(
      'BTCUSD', Math.floor(r.at / 1000), Math.floor((r.at + windowMs) / 1000), r.tf,
    ).catch(() => [] as Candle[]);
    const audit = evaluateSignalOutcome({
      plan,
      side: r.side,
      stage: r.stage,
      callAt: r.at,
      closeAtCall: r.close,
      windowMs,
      after,
    });
    /*
     * Where price actually finished the window, and how far that is from the
     * call. Recorded alongside the full intrabar first-hit audit trail.
     */
    const last = after[after.length - 1] ?? null;
    const move = last === null ? null : Math.round((last.close - r.close) * 100) / 100;
    await query(
      `UPDATE market_states SET
         outcome = $1, graded_at = $2, resolved_close = $3, move_pts = $4,
         triggered_at = $5, confirmed_at = COALESCE(confirmed_at, $6),
         target_hit_at = $7, stop_hit_at = $8, expired_at = $9,
         first_hit = $10, first_hit_price = $11, first_hit_time = $12,
         mfe = $13, mae = $14, mfe_price = $15, mae_price = $16,
         eval_window_min = COALESCE(eval_window_min, $17)
       WHERE id = $18`,
      [
        audit.outcome, nowMs, last?.close ?? null, move,
        audit.triggeredAt, audit.confirmedAt,
        audit.targetHitAt, audit.stopHitAt, audit.expiredAt,
        audit.firstHit, audit.firstHitPrice, audit.firstHitTime,
        audit.mfe, audit.mae, audit.mfePrice, audit.maePrice,
        Math.round(windowMs / 60_000),
        r.id,
      ],
    );
    graded += 1;
  }
  return graded;
}

/** The last few calls, newest first: the "AI signal history" list. */
export async function recentStates(tf: StateTf | null = null, limit = 10): Promise<StateRow[]> {
  await stateHistorySchema();
  const got = await rows<{
    id: number; at: number; tf: StateTf; event: MarketEvent; stage: string; side: Side | null;
    confirmed: boolean; confidence: number; close: number;
    trigger: number | null; target1: number | null; target2: number | null; invalidation: number | null;
    outcome: Outcome | null; graded_at: number | null;
    resolved_close: number | null; move_pts: number | null;
    triggered_at: number | null; confirmed_at: number | null;
    target_hit_at: number | null; stop_hit_at: number | null; expired_at: number | null;
    first_hit: string | null; first_hit_price: number | null; first_hit_time: number | null;
    mfe: number | null; mae: number | null; mfe_price: number | null; mae_price: number | null;
    eval_window_min: number | null; score: number | null; probability: number | null;
    regime: string | null; mtf_consensus: string | null;
  }>(
    `SELECT id, at, tf, event, stage, side, confirmed, confidence, close,
            trigger, target1, target2, invalidation, outcome, graded_at,
            resolved_close, move_pts,
            triggered_at, confirmed_at, target_hit_at, stop_hit_at, expired_at,
            first_hit, first_hit_price, first_hit_time,
            mfe, mae, mfe_price, mae_price,
            eval_window_min, score, probability, regime, mtf_consensus
       FROM market_states ${tf ? 'WHERE tf = $2' : ''} ORDER BY at DESC LIMIT $1`,
    tf ? [limit, tf] : [limit],
  );
  return got.map((r) => ({
    id: r.id, at: Number(r.at), tf: r.tf, event: r.event, stage: r.stage, side: r.side,
    confirmed: r.confirmed, confidence: r.confidence, close: r.close,
    plan: r.target1 === null || r.side === null ? null : {
      side: r.side, trigger: r.trigger ?? 0, target1: r.target1,
      target2: r.target2 ?? r.target1, invalidation: r.invalidation ?? 0,
    },
    outcome: outcomeOf(r.outcome as string | null),
    gradedAt: r.graded_at === null ? null : Number(r.graded_at),
    resolvedClose: r.resolved_close,
    movePts: r.move_pts,
    triggeredAt: r.triggered_at === null ? null : Number(r.triggered_at),
    confirmedAt: r.confirmed_at === null ? null : Number(r.confirmed_at),
    targetHitAt: r.target_hit_at === null ? null : Number(r.target_hit_at),
    stopHitAt: r.stop_hit_at === null ? null : Number(r.stop_hit_at),
    expiredAt: r.expired_at === null ? null : Number(r.expired_at),
    firstHit: (r.first_hit as 'TARGET' | 'STOP' | 'NONE' | null) ?? null,
    firstHitPrice: r.first_hit_price,
    firstHitTime: r.first_hit_time === null ? null : Number(r.first_hit_time),
    mfe: r.mfe,
    mae: r.mae,
    mfePrice: r.mfe_price,
    maePrice: r.mae_price,
    evalWindowMin: r.eval_window_min,
    score: r.score,
    probability: r.probability,
    regime: r.regime,
    mtfConsensus: r.mtf_consensus,
  }));
}

/**
 * How often the graded calls came good.
 *
 * Only the ones that resolved, and the count is given with it: "3 of 4" says
 * what "75%" hides. Unresolved calls are left out of both, because counting
 * them either way would be choosing an answer rather than measuring one.
 */
export async function hitRate(tf: StateTf | null = null): Promise<{ correct: number; graded: number }> {
  await stateHistorySchema();
  const r = await one<{ correct: string; graded: string }>(
    /*
     * Only the calls that actually ran. A setup whose trigger was never
     * reached is not a miss -- counting it would be marking the desk down for
     * a trade nobody took -- and one still inside its window has not finished.
     * The old words are included so rows written before 24 Sep still count.
     */
    `SELECT COUNT(*) FILTER (WHERE outcome IN ('TARGET_HIT', 'CORRECT')) AS correct,
            COUNT(*) FILTER (WHERE outcome IN ('TARGET_HIT', 'INVALIDATED', 'CORRECT', 'WRONG')) AS graded
       FROM market_states ${tf ? 'WHERE tf = $1' : ''}`,
    tf ? [tf] : [],
  );
  return { correct: Number(r?.correct ?? 0), graded: Number(r?.graded ?? 0) };
}
