/**
 * "Is everything all right?" in one answer, for the phone (6 Oct 2026).
 *
 * The desk's health is spread over five places -- the board's socket, the perp's tape, Delta's quota, the
 * engine's pass timings, the error log -- and a person away from the desk wants one word and, when it is not
 * "ok", the reasons in plain language. The rule lives here, pure, so it is stated once and tested; the route
 * only gathers the readings.
 */

export type Health = 'ok' | 'warn' | 'down';

export type GlanceReadings = {
  now: number;
  db: { ok: boolean; latencyMs: number };
  /** The option board: the newest thing that arrived from any source (decision 0007). */
  board: { source: string; connected: boolean; lastAt: number | null };
  /** The perp's trade tape. */
  tape: { source: string; connected: boolean; lastAt: number | null };
  delta: { usedPct: number; rateLimited: number; failed: number };
  /** Passes over the open trades in the last five minutes that ran past their interval. */
  latePasses: number;
  errors: { open: number; lastAt: number | null };
  schedulerOn: boolean;
  mode: 'live' | 'paper';
};

export type GlanceIssue = { level: Exclude<Health, 'ok'>; text: string };

/** A feed this old is late; this old, it has stopped. */
export const BOARD_LATE_MS = 15_000;
export const BOARD_DOWN_MS = 60_000;
export const TAPE_LATE_MS = 60_000;
/** Delta's quota used in the window above this is a warning: the next burst gets rate-limited. */
export const QUOTA_WARN_PCT = 80;

const ageOf = (lastAt: number | null, now: number) => (lastAt === null ? null : Math.max(0, now - lastAt));

const secs = (ms: number) => (ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

/** The readings, judged: one word for the whole desk, and every reason that is not "fine". */
export function judge(r: GlanceReadings): { health: Health; issues: GlanceIssue[]; boardAgeMs: number | null; tapeAgeMs: number | null } {
  const issues: GlanceIssue[] = [];
  const boardAgeMs = ageOf(r.board.lastAt, r.now);
  const tapeAgeMs = ageOf(r.tape.lastAt, r.now);

  if (!r.db.ok) issues.push({ level: 'down', text: 'The database is not answering: no trade can be journaled.' });

  if (boardAgeMs === null) issues.push({ level: 'down', text: 'No option prices have arrived since the desk started.' });
  else if (boardAgeMs >= BOARD_DOWN_MS) issues.push({ level: 'down', text: `Option prices stopped ${secs(boardAgeMs)} ago.` });
  else if (boardAgeMs >= BOARD_LATE_MS) issues.push({ level: 'warn', text: `Option prices are ${secs(boardAgeMs)} old.` });

  if (tapeAgeMs !== null && tapeAgeMs >= TAPE_LATE_MS) issues.push({ level: 'warn', text: `The perp's trade tape is ${secs(tapeAgeMs)} old.` });

  if (r.delta.rateLimited > 0) issues.push({ level: 'warn', text: `Delta rate-limited ${r.delta.rateLimited} call${r.delta.rateLimited === 1 ? '' : 's'} in the last 5 min.` });
  else if (r.delta.usedPct >= QUOTA_WARN_PCT) issues.push({ level: 'warn', text: `${r.delta.usedPct}% of Delta's call quota used in the last 5 min.` });
  if (r.delta.failed > 0) issues.push({ level: 'warn', text: `${r.delta.failed} call${r.delta.failed === 1 ? '' : 's'} to Delta failed in the last 5 min.` });

  if (r.latePasses > 0) issues.push({ level: 'warn', text: `The check on open trades ran late ${r.latePasses} time${r.latePasses === 1 ? '' : 's'} in the last 5 min.` });

  if (r.errors.open > 0) issues.push({ level: 'warn', text: `${r.errors.open}${r.errors.open >= 100 ? '+' : ''} error${r.errors.open === 1 ? '' : 's'} in the log not yet resolved.` });

  const health: Health = issues.some((i) => i.level === 'down') ? 'down' : issues.length ? 'warn' : 'ok';
  return { health, issues, boardAgeMs, tapeAgeMs };
}
