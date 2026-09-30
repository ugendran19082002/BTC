import type { Candle } from '../market/delta.js';
import { query, rows } from '../db/pool.js';
import { migrate, type Migration } from '../db/migrate.js';
import { FEE_PER_SIDE } from './engine.js';
import { TF_SEC, type MethodRead, type Tf } from './types.js';

/**
 * The entry setups' paper log: the forward test the 24 reads need before any
 * of them is believed.
 *
 * Every TRADE read is written once -- keyed by method, mode, timeframe,
 * direction and the bar its trigger closed on, so a setup that stays on the
 * board for ten minutes is one row -- and then graded from 1m candles, the way
 * a resting limit would have done:
 *
 *   open     waiting for price to trade into the entry zone; `expired` if it
 *            does not within FILL_WITHIN_BARS, or if the stop is hit first
 *   filled   in at the zone's near edge (or better, at a gap); then the stop,
 *            TP1 or HOLD_BARS, whichever comes first -- a bar touching both
 *            the stop and TP1 is the stop, the reading that cannot flatter
 *            the record
 *   tp1 / stop / timeout  closed, with `r_net` after taker fees both ways
 *
 * Nothing is ordered. With the timeframe chain and without it are separate
 * rows, so the record can say whether the chain adds anything.
 */

export const FILL_WITHIN_BARS = 12;
export const HOLD_BARS = 48;

const MIGRATIONS: Migration[] = [{
  id: 'entry-001-setups',
  up: `
    CREATE TABLE IF NOT EXISTS entry_setups (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      method      TEXT             NOT NULL,
      mode        TEXT             NOT NULL,
      tf          TEXT             NOT NULL,
      dir         SMALLINT         NOT NULL,
      trigger_at  BIGINT           NOT NULL,
      first_seen  BIGINT           NOT NULL,
      entry_lo    DOUBLE PRECISION NOT NULL,
      entry_hi    DOUBLE PRECISION NOT NULL,
      stop        DOUBLE PRECISION NOT NULL,
      tp1         DOUBLE PRECISION NOT NULL,
      tp2         DOUBLE PRECISION,
      rr          DOUBLE PRECISION NOT NULL,
      score       SMALLINT,
      status      TEXT             NOT NULL DEFAULT 'open',
      filled_at   BIGINT,
      fill_price  DOUBLE PRECISION,
      exit_at     BIGINT,
      exit_price  DOUBLE PRECISION,
      r_net       DOUBLE PRECISION,
      graded_to   BIGINT           NOT NULL,
      UNIQUE (method, mode, tf, dir, trigger_at),
      CHECK (status IN ('open', 'filled', 'expired', 'tp1', 'stop', 'timeout')),
      CHECK (mode IN ('mtf', 'single')),
      CHECK (dir IN (-1, 1))
    );
    CREATE INDEX IF NOT EXISTS entry_setups_working ON entry_setups (status) WHERE status IN ('open', 'filled');
    CREATE INDEX IF NOT EXISTS entry_setups_by_method ON entry_setups (method, mode, first_seen DESC);
  `,
}];

let ready: Promise<void> | null = null;
export function entrySchema(): Promise<void> {
  if (ready) return ready;
  ready = migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

/** Write each TRADE read once. Returns how many were new. */
export async function recordSetups(reads: readonly MethodRead[], nowMs: number): Promise<number> {
  await entrySchema();
  let n = 0;
  for (const r of reads) {
    if (r.state !== 'TRADE' || !r.plan || r.triggerTime === null || r.dir === null) continue;
    const res = await query(
      `INSERT INTO entry_setups (method, mode, tf, dir, trigger_at, first_seen, entry_lo, entry_hi, stop, tp1, tp2, rr, score, graded_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (method, mode, tf, dir, trigger_at) DO NOTHING`,
      [r.id, r.mode, r.tf, r.dir === 'long' ? 1 : -1, r.triggerTime, nowMs, r.plan.entryLo, r.plan.entryHi,
        r.plan.stop, r.plan.tp1, r.plan.tp2, r.plan.rr, r.score, Math.floor(nowMs / 60_000) * 60 - 60],
    );
    n += res.rowCount ?? 0;
  }
  return n;
}

export type PaperRow = {
  dir: 1 | -1; tf: Tf; triggerAt: number; firstSeen: number;
  entryLo: number; entryHi: number; stop: number; tp1: number;
  status: 'open' | 'filled' | 'expired' | 'tp1' | 'stop' | 'timeout';
  filledAt: number | null; fillPrice: number | null; exitAt: number | null; exitPrice: number | null;
  rNet: number | null; gradedTo: number;
};

/** R after taker fees both ways. */
export const rNetOf = (dir: 1 | -1, fill: number, exit: number, stop: number) => {
  const risk = Math.abs(fill - stop);
  return risk > 0 ? ((exit - fill) * dir - FEE_PER_SIDE * (fill + exit)) / risk : 0;
};

/** A row moved on by the closed 1m candles after `gradedTo`. Pure. */
export function gradeRow(row: PaperRow, bars1m: readonly Candle[]): PaperRow {
  let r = { ...row };
  const tfSec = TF_SEC[row.tf];
  const fillBy = row.triggerAt + tfSec * (1 + FILL_WITHIN_BARS);
  for (const b of bars1m) {
    if (b.time <= r.gradedTo || b.time * 1000 < Math.floor(row.firstSeen / 60_000) * 60_000) continue;
    if (r.status !== 'open' && r.status !== 'filled') break;
    const d = r.dir;
    const stopHit = d === 1 ? b.low <= r.stop : b.high >= r.stop;
    const stopAt = d === 1 ? Math.min(r.stop, b.open) : Math.max(r.stop, b.open);
    if (r.status === 'open') {
      const touches = d === 1 ? b.low <= r.entryHi : b.high >= r.entryLo;
      if (touches && !(d === 1 ? b.open <= r.stop : b.open >= r.stop)) {
        const fill = d === 1 ? Math.min(b.open, r.entryHi) : Math.max(b.open, r.entryLo);
        r = { ...r, status: 'filled', filledAt: b.time, fillPrice: fill };
        // In the fill bar only the stop is counted: which came first is not knowable from a candle.
        if (stopHit) r = close(r, b.time, stopAt, 'stop');
      } else if (stopHit) {
        r = { ...r, status: 'expired' };
      } else if (b.time >= fillBy) {
        r = { ...r, status: 'expired' };
      }
    } else if (stopHit) {
      r = close(r, b.time, stopAt, 'stop');
    } else if (d === 1 ? b.high >= r.tp1 : b.low <= r.tp1) {
      r = close(r, b.time, r.tp1, 'tp1');
    } else if (r.filledAt !== null && b.time >= r.filledAt + tfSec * HOLD_BARS) {
      r = close(r, b.time, b.close, 'timeout');
    }
    r.gradedTo = b.time;
  }
  return r;
}

function close(r: PaperRow, at: number, price: number, status: 'tp1' | 'stop' | 'timeout'): PaperRow {
  return { ...r, status, exitAt: at, exitPrice: price, rNet: rNetOf(r.dir, r.fillPrice!, price, r.stop) };
}

type DbRow = {
  id: number; dir: number; tf: Tf; trigger_at: number; first_seen: number; entry_lo: number; entry_hi: number;
  stop: number; tp1: number; status: PaperRow['status']; filled_at: number | null; fill_price: number | null;
  exit_at: number | null; exit_price: number | null; r_net: number | null; graded_to: number;
};

/** Grade every working row against the closed 1m candles. Returns how many changed status. */
export async function gradeSetups(bars1m: readonly Candle[]): Promise<number> {
  await entrySchema();
  const open = await rows<DbRow>(`SELECT * FROM entry_setups WHERE status IN ('open', 'filled')`);
  let moved = 0;
  for (const x of open) {
    const before: PaperRow = {
      dir: x.dir === 1 ? 1 : -1, tf: x.tf, triggerAt: x.trigger_at, firstSeen: x.first_seen,
      entryLo: x.entry_lo, entryHi: x.entry_hi, stop: x.stop, tp1: x.tp1, status: x.status,
      filledAt: x.filled_at, fillPrice: x.fill_price, exitAt: x.exit_at, exitPrice: x.exit_price,
      rNet: x.r_net, gradedTo: x.graded_to,
    };
    const after = gradeRow(before, bars1m);
    if (after.gradedTo === before.gradedTo) continue;
    if (after.status !== before.status) moved++;
    await query(
      `UPDATE entry_setups SET status = $2, filled_at = $3, fill_price = $4, exit_at = $5, exit_price = $6, r_net = $7, graded_to = $8
        WHERE id = $1`,
      [x.id, after.status, after.filledAt, after.fillPrice, after.exitAt, after.exitPrice, after.rNet, after.gradedTo],
    );
  }
  return moved;
}

export type MethodRecord = {
  method: string; mode: 'mtf' | 'single'; tf: Tf;
  /** Setups written. */
  setups: number;
  /** Filled and closed: TP1, stop or timeout. */
  trades: number;
  wins: number;
  expired: number;
  working: number;
  avgR: number | null;
  sumR: number | null;
  since: number | null;
};

/** Each method's record, with the timeframe chain and without it. */
export async function entryRecord(): Promise<MethodRecord[]> {
  await entrySchema();
  const out = await rows<{
    method: string; mode: 'mtf' | 'single'; tf: Tf; setups: number; trades: number; wins: number;
    expired: number; working: number; avg_r: number | null; sum_r: number | null; since: number | null;
  }>(
    `SELECT method, mode, tf,
            count(*)::int AS setups,
            count(*) FILTER (WHERE status IN ('tp1', 'stop', 'timeout'))::int AS trades,
            count(*) FILTER (WHERE status = 'tp1')::int AS wins,
            count(*) FILTER (WHERE status = 'expired')::int AS expired,
            count(*) FILTER (WHERE status IN ('open', 'filled'))::int AS working,
            avg(r_net) FILTER (WHERE status IN ('tp1', 'stop', 'timeout')) AS avg_r,
            sum(r_net) FILTER (WHERE status IN ('tp1', 'stop', 'timeout')) AS sum_r,
            min(first_seen) AS since
       FROM entry_setups GROUP BY method, mode, tf ORDER BY method, mode, tf`,
  );
  return out.map((x) => ({
    method: x.method, mode: x.mode, tf: x.tf, setups: x.setups, trades: x.trades, wins: x.wins,
    expired: x.expired, working: x.working, avgR: x.avg_r, sumR: x.sum_r, since: x.since,
  }));
}

/** The latest setups written, newest first, for the log under the board. */
export async function recentSetups(limit = 50) {
  await entrySchema();
  return rows<Record<string, unknown>>(
    'SELECT * FROM entry_setups ORDER BY first_seen DESC LIMIT $1', [Math.min(200, Math.max(1, limit))],
  );
}
