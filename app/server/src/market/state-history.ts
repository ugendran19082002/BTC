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
];

let ready: Promise<void> | null = null;
export function stateHistorySchema(): Promise<void> {
  if (ready) return ready;
  ready = migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

/**
 * CORRECT and WRONG are what they sound like. UNRESOLVED is the honest third
 * answer: the call was directional, the bars went neither to the target nor
 * through the invalidation, and calling that a win because price drifted the
 * right way is how a hit rate gets flattering. A range is never graded -- it
 * is a statement that nothing is happening, and nothing happening is not a
 * prediction anybody can be wrong about.
 */
export type Outcome = 'CORRECT' | 'WRONG' | 'UNRESOLVED' | 'NOT_GRADED';

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
};

/**
 * Did it come good, in the bars after it was called?
 *
 * Target before invalidation, on the bars' own highs and lows rather than
 * their closes -- a stop that was traded through is a stop that was hit,
 * whatever the bar closed at. A bar that reaches both is counted WRONG: the
 * order they happened in is not in the bar, and the assumption that goes
 * against the call is the one that cannot flatter it.
 */
export function verdictFor(plan: Plan | null, side: Side | null, after: readonly Candle[]): Outcome {
  if (!plan || side === null) return 'NOT_GRADED';
  if (!after.length) return 'UNRESOLVED';
  for (const bar of after) {
    const hitTarget = side === 'UP' ? bar.high >= plan.target1 : bar.low <= plan.target1;
    const hitStop = side === 'UP' ? bar.low <= plan.invalidation : bar.high >= plan.invalidation;
    if (hitStop) return 'WRONG';
    if (hitTarget) return 'CORRECT';
  }
  return 'UNRESOLVED';
}

/** The words the card puts in the right-hand column. */
export const outcomeWords = (o: Outcome | null): string =>
  o === 'CORRECT' ? 'Correct' : o === 'WRONG' ? 'Wrong' : o === 'UNRESOLVED' ? 'No follow-through' : '—';

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
        words, insight, volume_ratio, atr, parts, inputs, patterns, indicators)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
             $15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING id`,
    [
      read.at, read.tf, s.event, s.stage, s.side, s.confirmed, s.confidence, bar?.close ?? 0,
      s.level.resistance, s.level.support,
      s.plan?.trigger ?? null, s.plan?.target1 ?? null, s.plan?.target2 ?? null, s.plan?.invalidation ?? null,
      s.words, s.insight, s.volumeRatio, read.inputs.atr,
      JSON.stringify(s.parts), JSON.stringify(read.inputs),
      JSON.stringify(read.patterns.shown), JSON.stringify(read.indicators.shown),
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
 */
export async function gradeStates(nowMs = Date.now(), limit = 20): Promise<number> {
  await stateHistorySchema();
  const due = await rows<{
    id: number; at: number; tf: StateTf; side: Side | null; close: number;
    trigger: number | null; target1: number | null; target2: number | null; invalidation: number | null;
  }>(
    `SELECT id, at, tf, side, close, trigger, target1, target2, invalidation
       FROM market_states WHERE outcome IS NULL ORDER BY at DESC LIMIT $1`, [limit],
  );
  let graded = 0;
  for (const r of due) {
    const minutes = STATE_TF_MINUTES[r.tf] ?? 15;
    const windowMs = minutes * 60_000 * GRADE_BARS;
    if (nowMs < r.at + windowMs) continue;
    const plan: Plan | null = r.target1 === null || r.invalidation === null || r.side === null ? null : {
      side: r.side, trigger: r.trigger ?? 0, target1: r.target1, target2: r.target2 ?? r.target1,
      invalidation: r.invalidation,
    };
    // Fetched even for a range, which is not graded but still moved somewhere.
    const after = await candles(
      'BTCUSD', Math.floor(r.at / 1000), Math.floor((r.at + windowMs) / 1000), r.tf,
    ).catch(() => [] as Candle[]);
    const outcome = verdictFor(plan, r.side, after);
    /*
     * Where price actually finished the window, and how far that is from the
     * call. The verdict answers "did the plan work"; this answers "what did
     * BTC do", which is the other half and the one the list is read for. It is
     * recorded rather than worked out later from the next row, which would
     * make the figure depend on when the screen happened to be open.
     */
    const last = after[after.length - 1] ?? null;
    const move = last === null ? null : Math.round((last.close - r.close) * 100) / 100;
    await query(
      `UPDATE market_states SET outcome = $1, graded_at = $2, resolved_close = $3, move_pts = $4
        WHERE id = $5`,
      [outcome, nowMs, last?.close ?? null, move, r.id],
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
  }>(
    `SELECT id, at, tf, event, stage, side, confirmed, confidence, close,
            trigger, target1, target2, invalidation, outcome, graded_at,
            resolved_close, move_pts
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
    outcome: r.outcome,
    gradedAt: r.graded_at === null ? null : Number(r.graded_at),
    resolvedClose: r.resolved_close,
    movePts: r.move_pts,
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
    `SELECT COUNT(*) FILTER (WHERE outcome = 'CORRECT') AS correct,
            COUNT(*) FILTER (WHERE outcome IN ('CORRECT', 'WRONG')) AS graded
       FROM market_states ${tf ? 'WHERE tf = $1' : ''}`,
    tf ? [tf] : [],
  );
  return { correct: Number(r?.correct ?? 0), graded: Number(r?.graded ?? 0) };
}
