import { migrate, type Migration } from '../db/migrate.js';
import { one, query, rows } from '../db/pool.js';
import { livePerp } from './flow.js';

/**
 * BTC, once a minute, kept.
 *
 * Everything else on the desk records a *reading* -- the board, the tape, the
 * option chain -- and the price itself was only ever a column inside one of
 * them, at whatever cadence that recorder ran. So "what did BTC do between
 * 13:18 and 13:33" could not be answered without asking Delta for candles
 * again, and a signal's points moved could not be checked after the fact at
 * all.
 *
 * One row a minute, the price and nothing else. It is the series every "+350
 * pts" on the screen is measured against, and it is small: a year of minutes
 * is half a million rows of three numbers.
 *
 * The minute is the key, so a restart, a double timer or a replayed snapshot
 * cannot write the same minute twice.
 */

export const INDEX_BUCKET_MS = 60_000;
/** A year of minutes. Small, and long enough to compare a day with last month. */
export const INDEX_KEEP_MS = 365 * 24 * 3_600_000;

const MIGRATIONS: Migration[] = [
  {
    id: 'market-013-index-1m',
    up: `
      CREATE TABLE IF NOT EXISTS index_1m (
        at    BIGINT           PRIMARY KEY,
        price DOUBLE PRECISION NOT NULL,
        mark  DOUBLE PRECISION
      );
    `,
  },
];

let ready: Promise<void> | null = null;
export function indexSchema(): Promise<void> {
  if (ready) return ready;
  ready = migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

/**
 * Write this minute's price, unless this minute is already written.
 *
 * Returns the row when it wrote one and null when it did not, so a caller can
 * tell "already recorded" from "nothing to record" -- the timer runs more
 * often than the bucket, on purpose, so a missed tick is picked up by the next.
 */
export async function captureIndex(nowMs: number): Promise<{ at: number; price: number } | null> {
  await indexSchema();
  const at = Math.floor(nowMs / INDEX_BUCKET_MS) * INDEX_BUCKET_MS;
  if (await one('SELECT 1 FROM index_1m WHERE at = $1', [at])) return null;

  const t = await livePerp(nowMs);
  const price = t?.spot ?? null;
  // A minute with no price is a hole in the series, which is the honest
  // record: filling it with the last one would invent a tick that never was.
  if (price === null || !Number.isFinite(price) || price <= 0) return null;

  await query(
    'INSERT INTO index_1m (at, price, mark) VALUES ($1, $2, $3) ON CONFLICT (at) DO NOTHING',
    [at, price, t?.mark ?? null],
  );
  await query('DELETE FROM index_1m WHERE at < $1', [at - INDEX_KEEP_MS]);
  return { at, price };
}

export type IndexPoint = { at: number; price: number };

/** The series between two moments, oldest first. */
export async function indexBetween(fromMs: number, toMs: number, limit = 1_500): Promise<IndexPoint[]> {
  await indexSchema();
  const got = await rows<{ at: string; price: number }>(
    'SELECT at, price FROM index_1m WHERE at >= $1 AND at <= $2 ORDER BY at ASC LIMIT $3',
    [fromMs, toMs, limit],
  );
  return got.map((r) => ({ at: Number(r.at), price: r.price }));
}

/**
 * What BTC did over a window, in points and percent.
 *
 * The two ends are the first and last minute actually recorded inside the
 * window, and both are returned with it: a move measured over 40 minutes of a
 * 60-minute window is a different figure from one measured over the whole
 * hour, and a reader who cannot see which is being given cannot use either.
 */
export async function moveOver(fromMs: number, toMs: number): Promise<{
  from: IndexPoint; to: IndexPoint; points: number; pct: number; minutes: number;
} | null> {
  const series = await indexBetween(fromMs, toMs);
  const first = series[0];
  const last = series[series.length - 1];
  if (!first || !last || first.at === last.at) return null;
  const points = Math.round((last.price - first.price) * 100) / 100;
  return {
    from: first,
    to: last,
    points,
    pct: Math.round((points / first.price) * 10_000) / 100,
    minutes: Math.round((last.at - first.at) / 60_000),
  };
}
