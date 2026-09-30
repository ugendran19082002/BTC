import { query, rows, type Param } from '../db/pool.js';
import { migrate, type Migration } from '../db/migrate.js';
import type { MethodRead, Tf } from './types.js';

/**
 * The signal journal: every signal the entry engine gives -- every WAIT and
 * every TRADE, on every timeframe, with the chain and without it -- written on
 * the server, so nothing depends on a screen being open to be remembered.
 *
 * One row per setup per state: a setup is its method, way, timeframe,
 * direction and the bar its trigger closed on; a WAIT that becomes a TRADE is
 * two rows. A signal seen again the next minute is not a new row -- its
 * `last_seen` moves, so the journal also says how long each one stood.
 *
 * The paper log (entry_setups) is the other half: it grades the TRADEs. This
 * table is what was *shown*, graded or not.
 */

const MIGRATIONS: Migration[] = [{
  id: 'entry-005-signals',
  up: `
    CREATE TABLE IF NOT EXISTS entry_signals (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      method      TEXT             NOT NULL,
      mode        TEXT             NOT NULL CHECK (mode IN ('mtf', 'single')),
      tf          TEXT             NOT NULL,
      dir         SMALLINT         NOT NULL CHECK (dir IN (-1, 1)),
      state       TEXT             NOT NULL CHECK (state IN ('WAIT', 'TRADE')),
      trigger_at  BIGINT           NOT NULL,
      first_seen  BIGINT           NOT NULL,
      last_seen   BIGINT           NOT NULL,
      score       SMALLINT,
      reason      TEXT             NOT NULL,
      entry_lo    DOUBLE PRECISION,
      entry_hi    DOUBLE PRECISION,
      stop        DOUBLE PRECISION,
      tp1         DOUBLE PRECISION,
      rr          DOUBLE PRECISION,
      gates_off   TEXT[]           NOT NULL DEFAULT '{}',
      UNIQUE (method, mode, tf, dir, trigger_at, state)
    );
    CREATE INDEX IF NOT EXISTS entry_signals_by_time ON entry_signals (first_seen DESC);
  `,
}];

let ready: Promise<void> | null = null;
export function signalsSchema(): Promise<void> {
  if (ready) return ready;
  ready = migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

/** Signals kept this long; the paper log keeps its graded TRADEs for good. */
export const SIGNALS_KEEP_DAYS = 365;

/**
 * Write every WAIT and TRADE read once, and move `last_seen` on those already
 * written. Returns how many were new.
 */
export async function recordSignals(reads: readonly MethodRead[], nowMs: number): Promise<number> {
  await signalsSchema();
  let fresh = 0;
  for (const r of reads) {
    if ((r.state !== 'WAIT' && r.state !== 'TRADE') || r.dir === null || r.triggerTime === null) continue;
    const p = r.state === 'TRADE' ? r.plan : null;
    const res = await rows<{ inserted: boolean }>(
      `INSERT INTO entry_signals (method, mode, tf, dir, state, trigger_at, first_seen, last_seen, score, reason,
                                  entry_lo, entry_hi, stop, tp1, rr, gates_off)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (method, mode, tf, dir, trigger_at, state) DO UPDATE SET last_seen = EXCLUDED.last_seen
       RETURNING (xmax = 0) AS inserted`,
      [r.id, r.mode, r.tf, r.dir === 'long' ? 1 : -1, r.state, r.triggerTime, nowMs, r.score, r.reason,
        p?.entryLo ?? null, p?.entryHi ?? null, p?.stop ?? null, p?.tp1 ?? null, p?.rr ?? null,
        r.gates.filter((g) => !g.enabled).map((g) => g.key)],
    );
    if (res[0]?.inserted) fresh += 1;
  }
  return fresh;
}

/** Drop signals older than the keep period. Returns how many went. */
export async function pruneSignals(nowMs: number, keepDays = SIGNALS_KEEP_DAYS): Promise<number> {
  await signalsSchema();
  const res = await query('DELETE FROM entry_signals WHERE last_seen < $1', [nowMs - keepDays * 86_400_000]);
  return res.rowCount ?? 0;
}

export type SignalRow = {
  method: string; mode: 'mtf' | 'single'; tf: Tf; dir: 1 | -1; state: 'WAIT' | 'TRADE';
  triggerAt: number; firstSeen: number; lastSeen: number; score: number | null; reason: string;
  entryLo: number | null; entryHi: number | null; stop: number | null; tp1: number | null; rr: number | null;
  gatesOff: string[];
};

/** The latest signals, newest first, optionally one way, timeframe or state. */
export async function recentSignals(q: { limit?: number; mode?: string; tf?: string; state?: string } = {}): Promise<SignalRow[]> {
  await signalsSchema();
  const where: string[] = [];
  const args: Param[] = [];
  if (q.mode) { args.push(q.mode); where.push(`mode = $${args.length}`); }
  if (q.tf) { args.push(q.tf); where.push(`tf = $${args.length}`); }
  if (q.state) { args.push(q.state); where.push(`state = $${args.length}`); }
  args.push(Math.min(500, Math.max(1, q.limit ?? 100)));
  const rs = await rows<Record<string, unknown>>(
    `SELECT * FROM entry_signals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY first_seen DESC, id DESC LIMIT $${args.length}`,
    args,
  );
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return rs.map((r) => ({
    method: String(r.method), mode: r.mode as SignalRow['mode'], tf: r.tf as Tf, dir: Number(r.dir) as 1 | -1, state: r.state as SignalRow['state'],
    triggerAt: Number(r.trigger_at), firstSeen: Number(r.first_seen), lastSeen: Number(r.last_seen),
    score: num(r.score), reason: String(r.reason),
    entryLo: num(r.entry_lo), entryHi: num(r.entry_hi), stop: num(r.stop), tp1: num(r.tp1), rr: num(r.rr),
    gatesOff: (r.gates_off as string[] | null) ?? [],
  }));
}
