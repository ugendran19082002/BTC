import { DatabaseSync } from 'node:sqlite';
import { MARKET_DB } from '../paths.js';
import { migrate, hasColumn, type Migration } from '../db/sqlite-migrate.js';

/**
 * What open interest was, so the board can say what it has changed by.
 *
 * Delta's ticker carries the current figure and nothing else — no previous
 * value, no delta — so a change is only readable if the desk remembers. This is
 * that memory: one row per strike per bucket, and the difference between two
 * buckets is the answer.
 *
 * ## Its own file
 *
 * Market data is disposable and an order history is not, which is why
 * `trades.db` is its own file; the same argument puts this one somewhere else
 * again. `chain.db` would be the natural home except that it is read-only at
 * runtime — `refresh.sh` replaces it wholesale with a SQLite backup, and a
 * write here would be thrown away by the next harvest. So: `market.db`,
 * disposable, safe to delete, and nothing that matters is lost if it is.
 *
 * ## Five minutes, not five seconds
 *
 * The board polls every five seconds. Writing every poll is seventeen thousand
 * rows a strike a day to answer a question nobody asks at that resolution — an
 * hour is the shortest window a change in open interest means anything over.
 * Buckets are five minutes, and the writer is throttled to one per bucket per
 * expiry however many browsers are looking. The throttle asks the database
 * rather than remembering: a remembered bucket is a second copy of what the
 * file already knows, and the two come apart the moment a deploy or
 * `refresh.sh` replaces a file under a running process.
 */

const BUCKET_MS = 5 * 60_000;

/** A daily contract lives about a day; two days covers the overlap and no more. */
const KEEP_MS = 48 * 3600_000;

const MIGRATIONS: Migration[] = [
  {
    id: '001-oi-snapshots',
    up: `
      CREATE TABLE IF NOT EXISTS oi_snapshots (
        at     INTEGER NOT NULL,
        expiry TEXT    NOT NULL,
        cp     TEXT    NOT NULL CHECK (cp IN ('C','P')),
        strike INTEGER NOT NULL,
        oi     REAL    NOT NULL,
        spot   REAL    NOT NULL,
        PRIMARY KEY (at, expiry, cp, strike)
      );
      CREATE INDEX IF NOT EXISTS oi_by_expiry_time ON oi_snapshots (expiry, at);
    `,
  },
  {
    /*
     * At-the-money implied volatility, so an IV shock is readable the same way
     * an open-interest change is: against what it was a few buckets ago.
     *
     * A second migration rather than an edit to 001, which has already run.
     * Nullable, because the rows written before this existed have no value and
     * inventing one would put a made-up volatility in the history the shock
     * reading is measured against.
     */
    id: '002-atm-iv',
    up: (d) => {
      if (!hasColumn(d, 'oi_snapshots', 'atm_iv')) {
        d.exec('ALTER TABLE oi_snapshots ADD COLUMN atm_iv REAL');
      }
    },
  },
  {
    /*
     * The whole board every five minutes, so the chain can one day be measured
     * the way the candles were.
     *
     * chain.db holds one chain a day -- 05:30, twelve hours before settlement --
     * which is why only the straddle, the skew and put/call volume could be
     * measured at all. Open interest per strike, its change, the walls and max
     * pain have no history to be tested against. This is that history, from
     * 17 September 2026 forward. Kept 400 days: a row is a hundred bytes and
     * the point of it is the year.
     */
    id: '003-chain-features',
    up: `
      CREATE TABLE IF NOT EXISTS chain_features (
        at            INTEGER NOT NULL,
        expiry        TEXT    NOT NULL,
        spot          REAL    NOT NULL,
        hours_left    REAL    NOT NULL,
        atm_iv        REAL,
        call_atm      REAL,
        put_atm       REAL,
        put_marks     TEXT,
        call_marks    TEXT,
        put_volume    REAL,
        call_volume   REAL,
        pcr_oi        REAL,
        pcr_volume    REAL,
        ce_oi         REAL,
        pe_oi         REAL,
        iv_skew_pts   REAL,
        ce_wall       REAL,
        pe_wall       REAL,
        max_pain      REAL,
        ce_oi_change  REAL,
        pe_oi_change  REAL,
        PRIMARY KEY (at, expiry)
      );
    `,
  },
];

let db: DatabaseSync | null = null;

function open(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(MARKET_DB);
  db.exec('PRAGMA journal_mode = WAL');
  migrate(db, MIGRATIONS);
  return db;
}

/**
 * The market database, migrated, for the other disposable tables that live in
 * it. `expect` is the migration the caller needs, so a module that forgot to
 * add one fails here rather than at the first query.
 */
export function marketDb(expect?: string): DatabaseSync {
  const d = open();
  if (expect && !MIGRATIONS.some((m) => m.id === expect)) {
    throw new Error(`market.db has no migration ${expect}`);
  }
  return d;
}

/** For tests, and for anything that has just moved the file underneath us. */
export function closeOiHistory(): void {
  db?.close();
  db = null;
}

export type OiSnapshotLeg = { cp: 'C' | 'P'; strike: number; oi: number | null };

/**
 * Record what open interest is, at most once per bucket per expiry.
 *
 * Returns the bucket it wrote, or null when this one is already recorded — the
 * caller does not need to know, but a test does.
 *
 * It never throws. A board that cannot be drawn because a disposable side
 * table would not write is a board broken by its own bookkeeping, so the whole
 * thing is wrapped: the worst case is that the change column reads as absent,
 * which is exactly what it already does before the first bucket.
 */
export function noteOpenInterest(
  snap: { expiry: string; spot: number; ts: number; atmIv?: number | null },
  legs: readonly OiSnapshotLeg[],
): number | null {
  try {
    const atMs = Math.floor((snap.ts * 1000) / BUCKET_MS) * BUCKET_MS;

    const priced = legs.filter((l) => l.oi !== null && Number.isFinite(l.oi));
    if (!priced.length) return null;

    const d = open();

    /*
     * Ask the file, not a variable.
     *
     * The throttle was a Map of the last bucket written per expiry, which is a
     * second copy of something the database already knows -- and the two can
     * disagree. `refresh.sh` and a deploy both replace files underneath a
     * running process, and a remembered bucket would then skip writes for a
     * database that no longer has them. One indexed lookup per poll is nothing
     * beside the write it is avoiding.
     */
    const seen = d.prepare(
      'SELECT 1 FROM oi_snapshots WHERE expiry = ? AND at = ? LIMIT 1',
    ).get(snap.expiry, atMs);
    if (seen) return null;
    const insert = d.prepare(
      `INSERT OR REPLACE INTO oi_snapshots (at, expiry, cp, strike, oi, spot, atm_iv)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    d.exec('BEGIN');
    try {
      const iv = snap.atmIv ?? null;
      for (const l of priced) insert.run(atMs, snap.expiry, l.cp, l.strike, l.oi!, snap.spot, iv);
      d.prepare('DELETE FROM oi_snapshots WHERE at < ?').run(atMs - KEEP_MS);
      d.exec('COMMIT');
    } catch (e) {
      d.exec('ROLLBACK');
      throw e;
    }

    return atMs;
  } catch {
    return null;
  }
}

export type OiChange = {
  /** Contracts, against the bucket nearest the window asked for. */
  change: number;
  /** As a share of what was open then. Null when nothing was. */
  changePct: number | null;
  /** How far back the comparison actually reached, in minutes. */
  overMinutes: number;
  /** What BTC did over the same window, so the two can be read together. */
  spotChangePct: number | null;
};

const keyOf = (cp: 'C' | 'P', strike: number) => `${cp}${strike}`;

/**
 * How much open interest has changed, per strike, over roughly `hours`.
 *
 * "Roughly": it compares against the newest bucket at or before the target, so
 * a desk that has been up for twenty minutes answers over twenty minutes and
 * says so in `overMinutes`. A window the caller cannot see the length of is a
 * window they will read as the one they asked for.
 *
 * An empty map is the honest answer before the first bucket. Nothing here
 * invents a zero: "no change" and "no history" are different facts, and a board
 * showing +0 on a desk that has just started is lying about both.
 */
export function openInterestChange(
  now: { expiry: string; spot: number; ts: number },
  current: readonly OiSnapshotLeg[],
  hours = 1,
): Map<string, OiChange> {
  const out = new Map<string, OiChange>();
  try {
    const d = open();
    const targetMs = now.ts * 1000 - hours * 3600_000;

    /*
     * The newest bucket at or before the window asked for -- or, when the desk
     * has not been up that long, the oldest one there is.
     *
     * The fallback matters more than it looks. Without it the column is blank
     * for a full hour after every restart and every deploy, which is most of
     * the times anyone is actually watching it. With it, twenty minutes of
     * history answers over twenty minutes, and `overMinutes` is what keeps that
     * honest: a window nobody can see the length of is one they read as the
     * window they asked for.
     */
    const at = (
      d.prepare(
        'SELECT at FROM oi_snapshots WHERE expiry = ? AND at <= ? ORDER BY at DESC LIMIT 1',
      ).get(now.expiry, targetMs)
      ?? d.prepare(
        'SELECT at FROM oi_snapshots WHERE expiry = ? AND at < ? ORDER BY at ASC LIMIT 1',
      ).get(now.expiry, Math.floor(now.ts * 1000 / BUCKET_MS) * BUCKET_MS)
    ) as { at: number } | undefined;
    if (!at) return out;

    const rows = d.prepare(
      'SELECT cp, strike, oi, spot FROM oi_snapshots WHERE expiry = ? AND at = ?',
    ).all(now.expiry, at.at) as { cp: 'C' | 'P'; strike: number; oi: number; spot: number }[];
    if (!rows.length) return out;

    const overMinutes = Math.round((now.ts * 1000 - at.at) / 60_000);
    const then = rows[0]!.spot;
    const spotChangePct = then > 0 ? ((now.spot - then) / then) * 100 : null;

    const before = new Map(rows.map((r) => [keyOf(r.cp, r.strike), r.oi]));
    for (const l of current) {
      if (l.oi === null || !Number.isFinite(l.oi)) continue;
      const was = before.get(keyOf(l.cp, l.strike));
      if (was === undefined) continue;
      out.set(keyOf(l.cp, l.strike), {
        change: l.oi - was,
        changePct: was > 0 ? ((l.oi - was) / was) * 100 : null,
        overMinutes,
        spotChangePct,
      });
    }
    return out;
  } catch {
    return out;
  }
}

/**
 * The conventional reading of open interest against price.
 *
 * Long buildup, short buildup, short covering, long unwinding — the four
 * quadrants every futures screen shows.
 *
 * **It is a convention, not a signal, and on options it is weaker than it looks.**
 * Every option contract has a buyer and a seller, so rising open interest does
 * not say which side initiated it: the same +2,000 is "sellers writing calls"
 * and "buyers taking them" and the table cannot tell them apart. The desk shows
 * the label because it is what a trader expects to see beside the numbers, and
 * nothing reads it.
 */
export type OiReading = 'long_buildup' | 'short_buildup' | 'short_covering' | 'long_unwinding';

export function oiReading(change: OiChange): OiReading | null {
  const { spotChangePct } = change;
  if (spotChangePct === null) return null;
  // Under a tenth of a percent either way is not a direction, it is noise.
  if (Math.abs(spotChangePct) < 0.1 || change.change === 0) return null;
  const priceUp = spotChangePct > 0;
  const oiUp = change.change > 0;
  if (priceUp && oiUp) return 'long_buildup';
  if (!priceUp && oiUp) return 'short_buildup';
  if (priceUp && !oiUp) return 'short_covering';
  return 'long_unwinding';
}

/**
 * How at-the-money implied volatility has moved over roughly `minutes`.
 *
 * Null until there is a bucket that far back *carrying a volatility* — the
 * column was added after the table, so early rows have none, and a shock read
 * against a missing value would be a shock invented out of nothing.
 */
export function ivChange(
  now: { expiry: string; ts: number; atmIv: number | null },
  minutes = 15,
): { from: number; to: number; changePct: number; overMinutes: number } | null {
  if (now.atmIv === null || now.atmIv <= 0) return null;
  try {
    const d = open();
    const targetMs = now.ts * 1000 - minutes * 60_000;
    const row = d.prepare(
      `SELECT at, atm_iv FROM oi_snapshots
       WHERE expiry = ? AND at <= ? AND atm_iv IS NOT NULL
       ORDER BY at DESC LIMIT 1`,
    ).get(now.expiry, targetMs) as { at: number; atm_iv: number } | undefined;
    if (!row || !(row.atm_iv > 0)) return null;
    return {
      from: row.atm_iv,
      to: now.atmIv,
      changePct: ((now.atmIv - row.atm_iv) / row.atm_iv) * 100,
      overMinutes: Math.round((now.ts * 1000 - row.at) / 60_000),
    };
  } catch {
    return null;
  }
}
