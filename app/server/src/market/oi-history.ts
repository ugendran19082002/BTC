import { migrate, type Migration } from '../db/migrate.js';
import { one, query, rows, tx } from '../db/pool.js';

/**
 * What open interest was, so the board can say what it has changed by.
 *
 * Delta's ticker carries the current figure and nothing else — no previous
 * value, no delta — so a change is only readable if the desk remembers. This is
 * that memory: one row per strike per bucket, and the difference between two
 * buckets is the answer.
 *
 * ## Its own schema
 *
 * Market data is disposable and an order history is not, which is why the
 * trade journal has a schema of its own; the same argument puts this in
 * another. `chain.db` would be the natural home except that it is read-only
 * at runtime — `refresh.sh` replaces it wholesale with a SQLite backup, and a
 * write there would be thrown away by the next harvest. So: the `market`
 * schema, disposable, safe to truncate, and nothing that matters is lost if it is.
 *
 * ## Five minutes, not five seconds
 *
 * The board polls every five seconds. Writing every poll is seventeen thousand
 * rows a strike a day to answer a question nobody asks at that resolution — an
 * hour is the shortest window a change in open interest means anything over.
 * Buckets are five minutes, and the writer is throttled to one per bucket per
 * expiry however many browsers are looking. The throttle asks the database
 * rather than remembering: a remembered bucket is a second copy of what the
 * table already knows, and the two come apart the moment the table is
 * truncated under a running process.
 */

const BUCKET_MS = 5 * 60_000;

/** A daily contract lives about a day; two days covers the overlap and no more. */
const KEEP_MS = 48 * 3600_000;

const MIGRATIONS: Migration[] = [
  {
    /*
     * `atm_iv` is nullable on purpose: at-the-money implied volatility was
     * added after the table first shipped (as SQLite), and the rows written
     * before it have no value. Inventing one would put a made-up volatility in
     * the history the shock reading is measured against.
     */
    id: 'market-001-oi-snapshots',
    up: `
      CREATE SCHEMA IF NOT EXISTS market;
      CREATE TABLE IF NOT EXISTS market.oi_snapshots (
        at     BIGINT           NOT NULL,
        expiry TEXT             NOT NULL,
        cp     TEXT             NOT NULL CHECK (cp IN ('C','P')),
        strike INTEGER          NOT NULL,
        oi     DOUBLE PRECISION NOT NULL,
        spot   DOUBLE PRECISION NOT NULL,
        atm_iv DOUBLE PRECISION,
        PRIMARY KEY (at, expiry, cp, strike)
      );
      CREATE INDEX IF NOT EXISTS oi_by_expiry_time ON market.oi_snapshots (expiry, at);
    `,
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
    id: 'market-002-chain-features',
    up: `
      CREATE TABLE IF NOT EXISTS market.chain_features (
        at            BIGINT           NOT NULL,
        expiry        TEXT             NOT NULL,
        spot          DOUBLE PRECISION NOT NULL,
        hours_left    DOUBLE PRECISION NOT NULL,
        atm_iv        DOUBLE PRECISION,
        call_atm      DOUBLE PRECISION,
        put_atm       DOUBLE PRECISION,
        put_marks     JSONB,
        call_marks    JSONB,
        put_volume    DOUBLE PRECISION,
        call_volume   DOUBLE PRECISION,
        pcr_oi        DOUBLE PRECISION,
        pcr_volume    DOUBLE PRECISION,
        ce_oi         DOUBLE PRECISION,
        pe_oi         DOUBLE PRECISION,
        iv_skew_pts   DOUBLE PRECISION,
        ce_wall       DOUBLE PRECISION,
        pe_wall       DOUBLE PRECISION,
        max_pain      DOUBLE PRECISION,
        ce_oi_change  DOUBLE PRECISION,
        pe_oi_change  DOUBLE PRECISION,
        PRIMARY KEY (at, expiry)
      );
    `,
  },
];

let ready: Promise<void> | null = null;

/**
 * The market schema, migrated. Memoised, so the ledger is consulted once per
 * process; a failure is not remembered, so the next call tries again.
 */
export function marketSchema(): Promise<void> {
  if (ready) return ready;
  ready = migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

/** For tests: forget that the schema was checked, so the next call checks again. */
export function closeOiHistory(): void {
  ready = null;
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
export async function noteOpenInterest(
  snap: { expiry: string; spot: number; ts: number; atmIv?: number | null },
  legs: readonly OiSnapshotLeg[],
): Promise<number | null> {
  try {
    const atMs = Math.floor((snap.ts * 1000) / BUCKET_MS) * BUCKET_MS;

    const priced = legs.filter((l) => l.oi !== null && Number.isFinite(l.oi));
    if (!priced.length) return null;

    await marketSchema();

    /*
     * Ask the table, not a variable.
     *
     * The throttle was a Map of the last bucket written per expiry, which is a
     * second copy of something the database already knows -- and the two can
     * disagree once the table is cleared under a running process. One indexed
     * lookup per poll is nothing beside the write it is avoiding.
     */
    const seen = await one('SELECT 1 FROM market.oi_snapshots WHERE expiry = $1 AND at = $2 LIMIT 1', [snap.expiry, atMs]);
    if (seen) return null;

    const iv = snap.atmIv ?? null;
    await tx(async (c) => {
      for (const l of priced) {
        await c.query(
          `INSERT INTO market.oi_snapshots (at, expiry, cp, strike, oi, spot, atm_iv)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (at, expiry, cp, strike) DO UPDATE SET oi = EXCLUDED.oi, spot = EXCLUDED.spot, atm_iv = EXCLUDED.atm_iv`,
          [atMs, snap.expiry, l.cp, l.strike, l.oi!, snap.spot, iv],
        );
      }
      await c.query('DELETE FROM market.oi_snapshots WHERE at < $1', [atMs - KEEP_MS]);
    });

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
export async function openInterestChange(
  now: { expiry: string; spot: number; ts: number },
  current: readonly OiSnapshotLeg[],
  hours = 1,
): Promise<Map<string, OiChange>> {
  const out = new Map<string, OiChange>();
  try {
    await marketSchema();
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
    const at =
      await one<{ at: number }>(
        'SELECT at FROM market.oi_snapshots WHERE expiry = $1 AND at <= $2 ORDER BY at DESC LIMIT 1',
        [now.expiry, targetMs],
      )
      ?? await one<{ at: number }>(
        'SELECT at FROM market.oi_snapshots WHERE expiry = $1 AND at < $2 ORDER BY at ASC LIMIT 1',
        [now.expiry, Math.floor(now.ts * 1000 / BUCKET_MS) * BUCKET_MS],
      );
    if (!at) return out;

    const then_ = await rows<{ cp: 'C' | 'P'; strike: number; oi: number; spot: number }>(
      'SELECT cp, strike, oi, spot FROM market.oi_snapshots WHERE expiry = $1 AND at = $2',
      [now.expiry, at.at],
    );
    if (!then_.length) return out;

    const overMinutes = Math.round((now.ts * 1000 - at.at) / 60_000);
    const then = then_[0]!.spot;
    const spotChangePct = then > 0 ? ((now.spot - then) / then) * 100 : null;

    const before = new Map(then_.map((r) => [keyOf(r.cp, r.strike), r.oi]));
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
export async function ivChange(
  now: { expiry: string; ts: number; atmIv: number | null },
  minutes = 15,
): Promise<{ from: number; to: number; changePct: number; overMinutes: number } | null> {
  if (now.atmIv === null || now.atmIv <= 0) return null;
  try {
    await marketSchema();
    const targetMs = now.ts * 1000 - minutes * 60_000;
    const row = await one<{ at: number; atm_iv: number }>(
      `SELECT at, atm_iv FROM market.oi_snapshots
       WHERE expiry = $1 AND at <= $2 AND atm_iv IS NOT NULL
       ORDER BY at DESC LIMIT 1`,
      [now.expiry, targetMs],
    );
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
