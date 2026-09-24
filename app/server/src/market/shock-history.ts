import { migrate, type Migration } from '../db/migrate.js';
import { one, query, rows } from '../db/pool.js';
import type { ShockBand, SuddenMove } from '../domain/shock.js';

/**
 * The sudden-move reading, written down as it changes.
 *
 * The "big move catch" on the screen answers *is something about to happen*,
 * and a warning nobody can look back at is a warning nobody can believe. This
 * is the record: what the score was, which parts were raised, which way it
 * leaned, and -- once the bars exist -- what BTC actually did next.
 *
 * Written on change, not per poll. The reading is taken every time somebody
 * opens the screen; a row each would make this a journal of how often the page
 * was open. A row goes in when the band moves, when the score moves by enough
 * to matter, or when the last row is old enough that the series would have a
 * hole in it.
 */

export const SHOCK_SNAPSHOTS_KEEP_MS = 90 * 24 * 3_600_000;
/** A score move smaller than this is noise, not news. */
export const SCORE_STEP = 8;
/** However quiet it is, one row this often, so the series has no holes. */
export const HEARTBEAT_MS = 10 * 60_000;
/** How long after a reading its outcome is measured. */
export const OUTCOME_MS = 15 * 60_000;

const MIGRATIONS: Migration[] = [
  {
    /*
     * One table, one row per reading that said something new. `parts` is JSONB
     * because its shape is the shock engine's and will move with it -- a
     * column per part would be a migration every time one is added, and the
     * parts are read back as a set, never queried one at a time.
     */
    id: 'market-012-shock-snapshots',
    up: `
      CREATE TABLE IF NOT EXISTS shock_snapshots (
        id             BIGSERIAL PRIMARY KEY,
        at             BIGINT           NOT NULL,
        window_min     INTEGER          NOT NULL,
        score          DOUBLE PRECISION,
        band           TEXT             NOT NULL,
        direction      DOUBLE PRECISION,
        direction_label TEXT,
        spot           DOUBLE PRECISION,
        parts          JSONB,
        reasons        JSONB,
        /* Filled in later: where price went in the fifteen minutes after. */
        outcome_at     BIGINT,
        move_pts       DOUBLE PRECISION,
        move_pct       DOUBLE PRECISION
      );
      CREATE INDEX IF NOT EXISTS shock_snapshots_at ON shock_snapshots (window_min, at DESC);
      CREATE INDEX IF NOT EXISTS shock_snapshots_open ON shock_snapshots (at) WHERE outcome_at IS NULL;
    `,
  },
];

let ready: Promise<void> | null = null;
export function shockHistorySchema(): Promise<void> {
  if (ready) return ready;
  ready = migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

export type ShockRow = {
  id: number;
  at: number;
  windowMin: number;
  score: number | null;
  band: ShockBand;
  direction: number | null;
  directionLabel: string | null;
  spot: number | null;
  reasons: string[];
  /** Where price went in the quarter hour after the reading, once known. */
  outcomeAt: number | null;
  movePts: number | null;
  movePct: number | null;
};

/**
 * Is this reading worth a row?
 *
 * Pulled out and pure because it is the whole policy: too eager and the table
 * is a log of page views, too lazy and the series has holes exactly where
 * something was happening. A band change is always news; a score step is news;
 * otherwise the heartbeat keeps the series continuous.
 */
export function worthWriting(
  last: { at: number; band: string; score: number | null } | null,
  now: { at: number; band: string; score: number | null },
): boolean {
  if (!last) return true;
  if (last.band !== now.band) return true;
  if (now.at - last.at >= HEARTBEAT_MS) return true;
  if (last.score === null || now.score === null) return last.score !== now.score;
  return Math.abs(now.score - last.score) >= SCORE_STEP;
}

/** Write this reading down, unless the last row already says it. */
export async function noteShock(
  read: SuddenMove, at: number, spot: number | null,
): Promise<number | null> {
  await shockHistorySchema();
  const last = await one<{ at: string; band: string; score: number | null }>(
    'SELECT at, band, score FROM shock_snapshots WHERE window_min = $1 ORDER BY at DESC LIMIT 1',
    [read.window],
  );
  const previous = last ? { at: Number(last.at), band: last.band, score: last.score } : null;
  if (!worthWriting(previous, { at, band: read.band, score: read.score })) return null;

  const row = await one<{ id: number }>(
    `INSERT INTO shock_snapshots
       (at, window_min, score, band, direction, direction_label, spot, parts, reasons)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      at, read.window, read.score, read.band, read.direction, read.directionLabel, spot,
      JSON.stringify(read.parts), JSON.stringify(read.reasons),
    ],
  );
  await query('DELETE FROM shock_snapshots WHERE at < $1', [at - SHOCK_SNAPSHOTS_KEEP_MS]);
  return row?.id ?? null;
}

/**
 * Fill in what happened after the readings that are old enough to know.
 *
 * The warning's own claim is "something is about to move", so the honest
 * measure of it is the size of the move that followed, not its direction --
 * a score of 80 before a two percent fall was right.
 */
export async function settleShocks(nowMs: number, spot: number | null, limit = 20): Promise<number> {
  await shockHistorySchema();
  if (spot === null) return 0;
  const due = await rows<{ id: number; at: string; spot: number | null }>(
    `SELECT id, at, spot FROM shock_snapshots
      WHERE outcome_at IS NULL AND at <= $1 ORDER BY at ASC LIMIT $2`,
    [nowMs - OUTCOME_MS, limit],
  );
  let done = 0;
  for (const r of due) {
    if (r.spot === null) {
      // Nothing to measure from: closed off rather than left to be retried forever.
      await query('UPDATE shock_snapshots SET outcome_at = $1 WHERE id = $2', [nowMs, r.id]);
      done += 1;
      continue;
    }
    const pts = Math.round((spot - r.spot) * 100) / 100;
    await query(
      'UPDATE shock_snapshots SET outcome_at = $1, move_pts = $2, move_pct = $3 WHERE id = $4',
      [nowMs, pts, Math.round((pts / r.spot) * 10_000) / 100, r.id],
    );
    done += 1;
  }
  return done;
}

/** The last few readings for a window, newest first. */
export async function recentShocks(windowMin: number, limit = 20): Promise<ShockRow[]> {
  await shockHistorySchema();
  const got = await rows<{
    id: number; at: string; window_min: number; score: number | null; band: ShockBand;
    direction: number | null; direction_label: string | null; spot: number | null;
    reasons: string[] | null; outcome_at: string | null; move_pts: number | null; move_pct: number | null;
  }>(
    `SELECT id, at, window_min, score, band, direction, direction_label, spot, reasons,
            outcome_at, move_pts, move_pct
       FROM shock_snapshots WHERE window_min = $1 ORDER BY at DESC LIMIT $2`,
    [windowMin, limit],
  );
  return got.map((r) => ({
    id: r.id, at: Number(r.at), windowMin: r.window_min, score: r.score, band: r.band,
    direction: r.direction, directionLabel: r.direction_label, spot: r.spot,
    reasons: r.reasons ?? [],
    outcomeAt: r.outcome_at === null ? null : Number(r.outcome_at),
    movePts: r.move_pts, movePct: r.move_pct,
  }));
}

/**
 * How big a move followed each band, on average.
 *
 * The only question worth asking of a warning: when it said "sudden", did
 * anything happen? Given as the mean absolute move and the count behind it,
 * because a mean over four readings is not a finding.
 */
export async function shockOutcomes(windowMin: number): Promise<{ band: ShockBand; n: number; meanAbsPct: number }[]> {
  await shockHistorySchema();
  const got = await rows<{ band: ShockBand; n: string; mean: string | null }>(
    `SELECT band, COUNT(*) AS n, AVG(ABS(move_pct)) AS mean
       FROM shock_snapshots
      WHERE window_min = $1 AND move_pct IS NOT NULL
      GROUP BY band ORDER BY band`,
    [windowMin],
  );
  return got.map((r) => ({ band: r.band, n: Number(r.n), meanAbsPct: Math.round(Number(r.mean ?? 0) * 100) / 100 }));
}
