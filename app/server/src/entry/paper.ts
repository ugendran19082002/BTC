import type { Candle } from '../market/delta.js';
import { query, rows } from '../db/pool.js';
import { migrate, type Migration } from '../db/migrate.js';
import { TF_SEC, type MethodRead, type Tf } from './types.js';
import { bumpDataVersion } from './version.js';

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
 *            is never filled -- `expire_why`: `window` (not within
 *            FILL_WITHIN_BARS), `stop` (price went past the stop first: the
 *            idea was wrong before it was in), `target` (price ran to TP1
 *            without coming back: the move went without it, and a fill
 *            after the move is not the trade that was signalled)
 *   filled   in at the zone's near edge (or better, at a gap); then the stop,
 *            TP1 or HOLD_BARS, whichever comes first -- a bar touching both
 *            the stop and TP1 is the stop, the reading that cannot flatter
 *            the record
 *   runner   after TP1, the rest of the trade with its stop at the fill
 *            (breakeven), watched for TP2 then TP3 until breakeven, TP3 or
 *            the time-out -- `tp1_at` / `tp2_at` / `tp3_at` say which
 *            targets were reached and when. The record's R stays the TP1
 *            exit; the runner says how far the move went.
 *   tp1 / stop / timeout  closed, with `r_net`: the points made over the risk
 *            (no fee term since 1 Oct 2026, entry-010)
 *
 * Nothing is ordered. With the timeframe chain and without it are separate
 * rows, so the record can say whether the chain adds anything.
 */

export const FILL_WITHIN_BARS = 12;
export const HOLD_BARS = 48;

/**
 * When a setup stops waiting for its fill (epoch s): FILL_WITHIN_BARS of its
 * timeframe, counted from when it was on the board -- not from its trigger
 * bar, since an FVG or an order block can be forty bars old when price comes
 * back to it. The one rule the grading and the screen's counter both use.
 */
export function fillByOf(triggerAt: number, firstSeenMs: number, tf: Tf): number {
  const tfSec = TF_SEC[tf];
  return Math.max(triggerAt + tfSec, firstMinuteOf(firstSeenMs)) + tfSec * FILL_WITHIN_BARS;
}

/** When a filled setup is closed at the bar's close if neither the stop nor TP1 came (epoch s). */
export const timeoutAtOf = (filledAt: number, tf: Tf): number => filledAt + TF_SEC[tf] * HOLD_BARS;

/** The first whole minute after a moment (epoch s): the minute it was seen in had traded partly before it. */
const firstMinuteOf = (ms: number) => Math.ceil(ms / 60_000) * 60;

/**
 * How a fill and an exit stand against the plan, in points, + in the trade's
 * favour. A resting limit fills at the zone's near edge, or better when the
 * minute opens already inside it. TP1 is a limit: exactly the level. The stop
 * is a stop-market: the level, or the minute's open when price opened past it
 * (a gap) -- what a real stop would have got, so the record never flatters.
 */
export function fillExitOf(x: {
  dir: 1 | -1; status: string; entryLo: number; entryHi: number; stop: number; tp1: number;
  fillPrice: number | null; exitPrice: number | null;
}): { edge: number; fillBetterPts: number | null; level: number | null; pastPts: number | null; why: 'level' | 'gap' | 'time' | null } {
  const edge = x.dir === 1 ? x.entryHi : x.entryLo;
  const fillBetterPts = x.fillPrice === null ? null : round2((edge - x.fillPrice) * x.dir);
  if (x.exitPrice === null) return { edge, fillBetterPts, level: null, pastPts: null, why: null };
  if (x.status === 'timeout') return { edge, fillBetterPts, level: null, pastPts: null, why: 'time' };
  const level = x.status === 'stop' ? x.stop : x.tp1;
  // Points the exit was beyond the level, against the trade: 0 at the level.
  const pastPts = round2(Math.max(0, (level - x.exitPrice) * x.dir));
  return { edge, fillBetterPts, level, pastPts, why: pastPts > 0 ? 'gap' : 'level' };
}
const round2 = (v: number) => Math.round(v * 100) / 100 + 0;

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
}, {
  // The hard gates switched off when a setup was taken (entry/gates.ts), so the record can keep them apart.
  id: 'entry-003-setups-gates-off',
  up: `ALTER TABLE entry_setups ADD COLUMN IF NOT EXISTS gates_off TEXT[] NOT NULL DEFAULT '{}';`,
}, {

  // "After fees" removed from the entry section (owner, 1 Oct 2026): every closed row's R recomputed
  // the way rOf now does it -- points made over the risk from the fill -- so old and new rows agree.
  id: 'entry-010-r-without-fees',
  up: `
    UPDATE entry_setups SET r_net = ((exit_price - fill_price) * dir) / abs(fill_price - stop)
     WHERE exit_price IS NOT NULL AND fill_price IS NOT NULL AND fill_price <> stop;
  `,
}, {
  // TGT1 / TGT2 / TGT3 (owner, 1 Oct 2026): TP3 kept with the setup, when each target was reached, and the
  // runner after TP1 (stop at breakeven) that watches for TP2 and TP3. Rows written before keep NULLs.
  id: 'entry-012-setups-targets',
  up: `
    ALTER TABLE entry_setups ADD COLUMN IF NOT EXISTS tp3 DOUBLE PRECISION;
    ALTER TABLE entry_setups ADD COLUMN IF NOT EXISTS tp1_at BIGINT;
    ALTER TABLE entry_setups ADD COLUMN IF NOT EXISTS tp2_at BIGINT;
    ALTER TABLE entry_setups ADD COLUMN IF NOT EXISTS tp3_at BIGINT;
    ALTER TABLE entry_setups ADD COLUMN IF NOT EXISTS runner TEXT CHECK (runner IN ('running', 'done'));
    ALTER TABLE entry_setups ADD COLUMN IF NOT EXISTS runner_end TEXT CHECK (runner_end IN ('be', 'tp2', 'tp3', 'timeout'));
    UPDATE entry_setups SET tp1_at = exit_at WHERE status = 'tp1' AND tp1_at IS NULL;
    CREATE INDEX IF NOT EXISTS entry_setups_running ON entry_setups (runner) WHERE runner = 'running';
  `,
}, {
  // `missed` (1 Oct 2026): a limit cancelled because price ran to TP1 without coming back to fill it.
  id: 'entry-013-setups-missed',
  up: `
    ALTER TABLE entry_setups DROP CONSTRAINT IF EXISTS entry_setups_status_check;
    ALTER TABLE entry_setups ADD CONSTRAINT entry_setups_status_check
      CHECK (status IN ('open', 'filled', 'expired', 'missed', 'tp1', 'stop', 'timeout'));
  `,
}, {
  // A setup ends filled-and-closed (TP1, stop, time-out) or never filled (expired) -- the owner, 1 Oct 2026:
  // "missed" is not an ending of its own but a reason a setup expired. Each expiry keeps its reason;
  // the missed rows become expired, by target. Older expired rows have no recorded reason (NULL).
  id: 'entry-015-setups-expire-why',
  up: `
    ALTER TABLE entry_setups ADD COLUMN IF NOT EXISTS expire_why TEXT CHECK (expire_why IN ('window', 'stop', 'target'));
    UPDATE entry_setups SET status = 'expired', expire_why = 'target' WHERE status = 'missed';
    ALTER TABLE entry_setups DROP CONSTRAINT IF EXISTS entry_setups_status_check;
    ALTER TABLE entry_setups ADD CONSTRAINT entry_setups_status_check
      CHECK (status IN ('open', 'filled', 'expired', 'tp1', 'stop', 'timeout'));
  `,
}, {
  // The market each setup was taken in (methods.ts regimeOf), for sorting the record by it.
  id: 'entry-017-setups-regime',
  up: `ALTER TABLE entry_setups ADD COLUMN IF NOT EXISTS regime JSONB;`,
}];

let ready: Promise<void> | null = null;
export function entrySchema(): Promise<void> {
  if (ready) return ready;
  ready = migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

/**
 * Write each TRADE read once. Returns how many were new; `onNew` hears each
 * one as it is first written -- the moment an alert belongs to, once per setup.
 */
export async function recordSetups(reads: readonly MethodRead[], nowMs: number, onNew?: (r: MethodRead) => void): Promise<number> {
  await entrySchema();
  let n = 0;
  for (const r of reads) {
    if (r.state !== 'TRADE' || !r.plan || r.triggerTime === null || r.dir === null) continue;
    const res = await query(
      `INSERT INTO entry_setups (method, mode, tf, dir, trigger_at, first_seen, entry_lo, entry_hi, stop, tp1, tp2, rr, score, graded_to, gates_off, tp3, regime)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (method, mode, tf, dir, trigger_at) DO NOTHING`,
      [r.id, r.mode, r.tf, r.dir === 'long' ? 1 : -1, r.triggerTime, nowMs, r.plan.entryLo, r.plan.entryHi,
        r.plan.stop, r.plan.tp1, r.plan.tp2, r.plan.rr, r.score, Math.floor(nowMs / 60_000) * 60 - 60,
        // The gates this setup was taken under with any switched off: the record keeps these apart.
        r.gates.filter((g) => !g.enabled).map((g) => g.key), r.plan.tp3, r.regime ? JSON.stringify(r.regime) : null],
    );
    if ((res.rowCount ?? 0) > 0) { n += 1; bumpDataVersion(); onNew?.(r); }
  }
  return n;
}

export type PaperRow = {
  dir: 1 | -1; tf: Tf; triggerAt: number; firstSeen: number;
  entryLo: number; entryHi: number; stop: number; tp1: number;
  status: 'open' | 'filled' | 'expired' | 'tp1' | 'stop' | 'timeout';
  /** Why an expired setup was never filled. */
  expireWhy?: ExpireWhy | null;
  filledAt: number | null; fillPrice: number | null; exitAt: number | null; exitPrice: number | null;
  rNet: number | null; gradedTo: number;
  /** The further targets, and when each target was reached (the 1m bar, epoch s). */
  tp2?: number | null; tp3?: number | null;
  tp1At?: number | null; tp2At?: number | null; tp3At?: number | null;
  /** After TP1: the runner, watched for TP2/TP3 with its stop at breakeven, and how it ended. */
  runner?: 'running' | 'done' | null;
  runnerEnd?: RunnerEnd | null;
};

/** Why a setup was never filled: its window passed, the stop came first, or price ran to TP1 without it. */
export type ExpireWhy = 'window' | 'stop' | 'target';

/** How a runner ended: back to breakeven, at its last target, or on time. */
export type RunnerEnd = 'be' | 'tp2' | 'tp3' | 'timeout';

/** R: the points made, (exit - fill) x direction, over the risk from the fill to the stop. No fee term. */
export const rOf = (dir: 1 | -1, fill: number, exit: number, stop: number) => {
  const risk = Math.abs(fill - stop);
  return risk > 0 ? ((exit - fill) * dir) / risk : 0;
};

/** A row moved on by the closed 1m candles after `gradedTo`. Pure. */
export function gradeRow(row: PaperRow, bars1m: readonly Candle[]): PaperRow {
  let r = { ...row };
  // Graded from the first whole minute after the setup was seen: the minute it
  // was seen in had traded partly before it, and a fill there would be hindsight.
  const from = firstMinuteOf(row.firstSeen);
  const fillBy = fillByOf(row.triggerAt, row.firstSeen, row.tf);
  for (const b of bars1m) {
    if (b.time <= r.gradedTo || b.time < from) continue;
    if (!working(r)) break;
    r = { ...stepOn(r, b, fillBy, false), gradedTo: b.time };
  }
  return r;
}

/** Still being graded: waiting for its fill, in the trade, or a runner out for TP2 / TP3. */
export const working = (r: Pick<PaperRow, 'status' | 'runner'>) => r.status === 'open' || r.status === 'filled' || (r.status === 'tp1' && r.runner === 'running');

/**
 * A row moved on by the perpetual's trades, one at a time, as they print --
 * the live grader (entry/live-grade.ts). Each trade is a one-price candle
 * through the same rules as a 1m candle, with one difference: a limit that was
 * already resting fills at its own price when a trade goes through it (a
 * resting limit never fills better than its price), while one placed into a
 * market already past it fills at that trade, as a marketable limit does.
 * Stops fill at the first trade through them -- the stop and any slippage, as
 * it printed. Times are the trade's second. Pure.
 */
export function gradeTicks(row: PaperRow, prints: readonly { at: number; price: number }[], resting: boolean): { row: PaperRow; lastAt: number | null } {
  let r = { ...row };
  const fillBy = fillByOf(row.triggerAt, row.firstSeen, row.tf);
  let lastAt: number | null = null;
  let rest = resting;
  for (const p of prints) {
    if (p.at < row.firstSeen) continue;
    if (!working(r)) break;
    const t = Math.floor(p.at / 1000);
    r = stepOn(r, { time: t, open: p.price, high: p.price, low: p.price, close: p.price, volume: 0 }, fillBy, rest);
    rest = true;
    lastAt = p.at;
  }
  return { row: r, lastAt };
}

/**
 * One step of the grading: a 1m candle, or one trade as a one-price candle.
 * `restingLimit`: the entry limit has been resting since before this step, so
 * it fills at its own price (ticks); otherwise at the open when price opened
 * inside the zone (candles, or a limit placed into a market already past it).
 */
function stepOn(row: PaperRow, b: Candle, fillBy: number, restingLimit: boolean): PaperRow {
  let r = row;
  if (r.status === 'tp1' && r.runner === 'running') return runOn(r, b);
  const d = r.dir;
  const stopHit = d === 1 ? b.low <= r.stop : b.high >= r.stop;
  const stopAt = d === 1 ? Math.min(r.stop, b.open) : Math.max(r.stop, b.open);
  if (r.status === 'open') {
    const touches = d === 1 ? b.low <= r.entryHi : b.high >= r.entryLo;
    if (touches && !(d === 1 ? b.open <= r.stop : b.open >= r.stop)) {
      const edge = d === 1 ? r.entryHi : r.entryLo;
      const fill = restingLimit ? edge : d === 1 ? Math.min(b.open, r.entryHi) : Math.max(b.open, r.entryLo);
      r = { ...r, status: 'filled', filledAt: b.time, fillPrice: fill };
      // In the fill bar only the stop is counted: which came first is not knowable from a candle.
      if (stopHit) r = close(r, b.time, stopAt, 'stop');
    } else if (stopHit) {
      r = { ...r, status: 'expired', expireWhy: 'stop' };
    } else if (d === 1 ? b.high >= r.tp1 : b.low <= r.tp1) {
      // Price ran to TP1 without coming back to the zone: the move went without us. The limit is
      // cancelled -- filling it later, after the move is done, is not the trade that was signalled.
      r = { ...r, status: 'expired', expireWhy: 'target' };
    } else if (b.time >= fillBy) {
      r = { ...r, status: 'expired', expireWhy: 'window' };
    }
  } else if (stopHit) {
    r = close(r, b.time, stopAt, 'stop');
  } else if (d === 1 ? b.high >= r.tp1 : b.low <= r.tp1) {
    r = close(r, b.time, r.tp1, 'tp1');
    // A further target: the rest runs on from the next step, its stop at breakeven.
    r = { ...r, tp1At: b.time, tp2At: null, tp3At: null, runner: r.tp2 != null ? 'running' : null, runnerEnd: null };
  } else if (r.filledAt !== null && b.time >= timeoutAtOf(r.filledAt, r.tf)) {
    r = close(r, b.time, b.close, 'timeout');
  }
  return r;
}

/**
 * One minute of a runner after TP1: its stop is the fill (breakeven), checked
 * first -- a bar touching both is breakeven, the reading that cannot flatter.
 * Then TP2, then TP3 (a bar can reach both); the time-out ends it as for the
 * trade. Pure.
 */
function runOn(r: PaperRow, b: Candle): PaperRow {
  const d = r.dir;
  const done = (end: RunnerEnd, x: Partial<PaperRow> = {}): PaperRow => ({ ...r, ...x, runner: 'done', runnerEnd: end });
  if (d === 1 ? b.low <= r.fillPrice! : b.high >= r.fillPrice!) return done('be');
  const reaches = (lvl: number) => (d === 1 ? b.high >= lvl : b.low <= lvl);
  let x: Partial<PaperRow> = {};
  if (r.tp2At == null && r.tp2 != null && reaches(r.tp2)) x = { tp2At: b.time };
  if ((r.tp2At ?? x.tp2At) != null && r.tp3 != null && reaches(r.tp3)) return done('tp3', { ...x, tp3At: b.time });
  if ((r.tp2At ?? x.tp2At) != null && r.tp3 == null) return done('tp2', x);
  if (r.filledAt !== null && b.time >= timeoutAtOf(r.filledAt, r.tf)) return done('timeout', x);
  return { ...r, ...x };
}

function close(r: PaperRow, at: number, price: number, status: 'tp1' | 'stop' | 'timeout'): PaperRow {
  return { ...r, status, exitAt: at, exitPrice: price, rNet: rOf(r.dir, r.fillPrice!, price, r.stop) };
}

type DbRow = {
  id: number; dir: number; tf: Tf; trigger_at: number; first_seen: number; entry_lo: number; entry_hi: number;
  stop: number; tp1: number; status: PaperRow['status']; filled_at: number | null; fill_price: number | null;
  exit_at: number | null; exit_price: number | null; r_net: number | null; graded_to: number;
  tp2: number | null; tp3: number | null; tp1_at: number | null; tp2_at: number | null; tp3_at: number | null;
  runner: PaperRow['runner']; runner_end: RunnerEnd | null; expire_why: ExpireWhy | null;
};

/**
 * One grader at a time: the live tick grader (every second) and the 1m candle
 * grader (each minute) read a row and write it back, and must never interleave
 * -- one would overwrite the other's move.
 */
let gradeQueue: Promise<unknown> = Promise.resolve();
export function withGradeLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = gradeQueue.then(fn, fn);
  gradeQueue = run.catch(() => {});
  return run;
}

/** Grade every working row against the closed 1m candles. Returns how many changed status. */
export function gradeSetups(bars1m: readonly Candle[]): Promise<number> {
  return withGradeLock(() => gradeSetupsNow(bars1m));
}

/** The working rows as the graders read them. */
export async function workingRows(): Promise<(PaperRow & { id: number })[]> {
  await entrySchema();
  const open = await rows<DbRow>(`SELECT * FROM entry_setups WHERE status IN ('open', 'filled') OR runner = 'running'`);
  return open.map((x) => ({ id: Number(x.id), ...rowOf(x) }));
}

/** A row written back after grading: every field a grader moves. */
export async function saveGraded(id: number, r: PaperRow): Promise<void> {
  await query(
    `UPDATE entry_setups SET status = $2, filled_at = $3, fill_price = $4, exit_at = $5, exit_price = $6, r_net = $7, graded_to = $8,
            tp1_at = $9, tp2_at = $10, tp3_at = $11, runner = $12, runner_end = $13, expire_why = $14
      WHERE id = $1`,
    [id, r.status, r.filledAt, r.fillPrice, r.exitAt, r.exitPrice, r.rNet, r.gradedTo,
      r.tp1At ?? null, r.tp2At ?? null, r.tp3At ?? null, r.runner ?? null, r.runnerEnd ?? null, r.expireWhy ?? null],
  );
  bumpDataVersion();
}

const rowOf = (x: DbRow): PaperRow => ({
  dir: Number(x.dir) === 1 ? 1 : -1, tf: x.tf, triggerAt: Number(x.trigger_at), firstSeen: Number(x.first_seen),
  entryLo: x.entry_lo, entryHi: x.entry_hi, stop: x.stop, tp1: x.tp1, status: x.status,
  filledAt: x.filled_at === null ? null : Number(x.filled_at), fillPrice: x.fill_price,
  exitAt: x.exit_at === null ? null : Number(x.exit_at), exitPrice: x.exit_price,
  rNet: x.r_net, gradedTo: Number(x.graded_to),
  tp2: x.tp2, tp3: x.tp3, tp1At: x.tp1_at === null ? null : Number(x.tp1_at), tp2At: x.tp2_at === null ? null : Number(x.tp2_at),
  tp3At: x.tp3_at === null ? null : Number(x.tp3_at), runner: x.runner, runnerEnd: x.runner_end, expireWhy: x.expire_why,
});

async function gradeSetupsNow(bars1m: readonly Candle[]): Promise<number> {
  await entrySchema();
  let moved = 0;
  for (const { id, ...before } of await workingRows()) {
    const after = gradeRow(before, bars1m);
    if (after.gradedTo === before.gradedTo) continue;
    if (after.status !== before.status) moved++;
    await saveGraded(id, after);
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
  /** Gross R won over gross R lost. Null with no losing trade to divide by. */
  profitFactor: number | null;
  /** Deepest fall of the running R total from its high, in R (0 or negative). */
  maxDrawdownR: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  /** Setups written while a hard gate was switched off: kept, but not in any figure above. */
  gatesOff: number;
  /** Points made at TP1, lost at the stop, and the net over every closed trade -- each from the fill to the exit. */
  tgtPts: number; slPts: number; netPts: number;
  since: number | null;
};

/** The same figures over a set of closed trades' R, in the order they closed. Pure. */
export function statsOf(rs: readonly number[]): Pick<MethodRecord, 'trades' | 'wins' | 'avgR' | 'sumR' | 'profitFactor' | 'maxDrawdownR' | 'avgWinR' | 'avgLossR'> {
  if (!rs.length) return { trades: 0, wins: 0, avgR: null, sumR: null, profitFactor: null, maxDrawdownR: null, avgWinR: null, avgLossR: null };
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const sum = rs.reduce((a, b) => a + b, 0);
  const won = wins.reduce((a, b) => a + b, 0);
  const lost = -losses.reduce((a, b) => a + b, 0);
  let run = 0;
  let peak = 0;
  let dd = 0;
  for (const r of rs) { run += r; peak = Math.max(peak, run); dd = Math.min(dd, run - peak); }
  return {
    trades: rs.length, wins: wins.length, avgR: sum / rs.length, sumR: sum,
    profitFactor: lost > 0 ? won / lost : null, maxDrawdownR: dd,
    avgWinR: wins.length ? won / wins.length : null, avgLossR: losses.length ? -lost / losses.length : null,
  };
}

/** Points from the fill to the exit, in the trade's favour, summed by how the trades ended. */
function pointsOf(closed: readonly { status: string; dir: number; fill_price: number | null; exit_price: number | null }[]) {
  const p = (x: (typeof closed)[number]) => (x.fill_price === null || x.exit_price === null ? 0 : (Number(x.exit_price) - Number(x.fill_price)) * Number(x.dir));
  return {
    tgtPts: closed.filter((x) => x.status === 'tp1').reduce((a, x) => a + p(x), 0),
    slPts: 0 - closed.filter((x) => x.status === 'stop').reduce((a, x) => a + p(x), 0),
    netPts: closed.reduce((a, x) => a + p(x), 0),
  };
}

type ClosedRow = {
  method: string; mode: 'mtf' | 'single'; tf: Tf; status: PaperRow['status']; r_net: number | null; first_seen: number; gates_off: string[];
  dir: number; fill_price: number | null; exit_price: number | null;
};

/**
 * Each method's record, with the timeframe chain and without it, and each
 * mode's total over all twelve -- the comparison the screen puts side by side.
 */
/**
 * `totals` is the rules as designed -- every gate on. `totalsAll` counts every
 * setup, those let through by a switched-off gate included, and is shown apart
 * and labelled as such: the one figure never quietly stands in for the other.
 */
export async function entryRecord(): Promise<{ records: MethodRecord[]; totals: MethodRecord[]; totalsAll: MethodRecord[] }> {
  await entrySchema();
  const all = await rows<ClosedRow>(
    `SELECT method, mode, tf, status, r_net, first_seen, gates_off, dir, fill_price, exit_price FROM entry_setups ORDER BY coalesce(exit_at, graded_to), id`,
  );
  const group = (key: (r: ClosedRow) => string) => {
    const m = new Map<string, ClosedRow[]>();
    for (const r of all) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return m;
  };
  // The record is the rules as designed: a setup let through by a switched-off gate is counted apart.
  const recordOf = (all: ClosedRow[], method: string, withGatesOff = false): MethodRecord => {
    const xs = withGatesOff ? all : all.filter((x) => !x.gates_off?.length);
    const closed = xs.filter((x) => x.status === 'tp1' || x.status === 'stop' || x.status === 'timeout');
    return {
      method, mode: all[0]!.mode, tf: all[0]!.tf,
      setups: xs.length,
      expired: xs.filter((x) => x.status === 'expired').length,
      working: xs.filter((x) => x.status === 'open' || x.status === 'filled').length,
      since: Math.min(...all.map((x) => x.first_seen)),
      ...statsOf(closed.map((x) => x.r_net ?? 0)),
      gatesOff: all.filter((x) => x.gates_off?.length).length,
      ...pointsOf(closed),
    };
  };
  const records = [...group((r) => `${r.method}|${r.mode}|${r.tf}`).values()].map((xs) => recordOf(xs, xs[0]!.method))
    .sort((a, b) => a.method.localeCompare(b.method) || a.mode.localeCompare(b.mode) || a.tf.localeCompare(b.tf));
  const byWay = [...group((r) => `${r.mode}|${r.tf}`).values()];
  const totals = byWay.map((xs) => recordOf(xs, 'all'));
  const totalsAll = byWay.map((xs) => recordOf(xs, 'all', true));
  return { records, totals, totalsAll };
}

/** The latest setups written, newest first, for the log under the board. */
export async function recentSetups(limit = 50) {
  await entrySchema();
  return rows<Record<string, unknown>>(
    'SELECT * FROM entry_setups ORDER BY first_seen DESC LIMIT $1', [Math.min(200, Math.max(1, limit))],
  );
}
