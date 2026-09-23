import type { Ticker } from './delta.js';
import { expiryTsOf } from './chain.js';
import { migrate, type Migration } from '../db/migrate.js';
import { one, query } from '../db/pool.js';

/**
 * Every strike of the traded expiries: a five-minute record kept for months,
 * and a one-minute record kept for hours.
 *
 * Delta publishes greeks, IV and quotes live only (docs/Data.md §2); without
 * this, "how did the 78,000 call's IV and OI move through the morning" has no
 * answer after the fact. It is the raw layer: features (premium momentum, OI
 * acceleration, IV change) are derived from it, never stored instead of it, so
 * a feature thought of next month can still be computed over last month.
 *
 * Scope: the two nearest listed expiries -- today's contract and the one the
 * 05:30 entry sells -- every strike Delta lists for them.
 *
 * Two grains, because they answer different questions and cost differently
 * (measured 22 Sep 2026: about 350 bytes a row, 161 strikes a bucket):
 *
 *   five minutes, 90 days   the record the hour-ago and day-ago reads use.
 *                           ~16 MB a day, ~1.4 GB at 90 days.
 *   one minute, 6 hours     what the last hour actually did, minute by minute:
 *                           the 1m window and the premium's velocity. ~81 MB a
 *                           day if it were kept, ~20 MB as a rolling six hours.
 *
 * Neither costs an extra request: the recorder already wakes every minute and
 * the five-minute write is skipped when its bucket exists.
 */

export const OPTION_SNAPSHOT_BUCKET_MS = 5 * 60_000;
/** 90 days of the five-minute record: ~1.4 GB, against a disk with 12 GB free. */
export const OPTION_SNAPSHOT_KEEP_MS = 90 * 24 * 3600_000;
/** The fine record: every minute, six hours deep. */
export const OPTION_SNAPSHOT_1M_BUCKET_MS = 60_000;
export const OPTION_SNAPSHOT_1M_KEEP_MS = 6 * 3600_000;
/** How many of the nearest expiries are recorded. */
export const OPTION_SNAPSHOT_EXPIRIES = 2;

const MIGRATIONS: Migration[] = [
  {
    id: 'market-004-option-snapshots',
    up: `
      CREATE TABLE IF NOT EXISTS option_snapshots (
        at        BIGINT           NOT NULL,
        symbol    TEXT             NOT NULL,
        expiry    TEXT             NOT NULL,
        cp        TEXT             NOT NULL CHECK (cp IN ('C','P')),
        strike    INTEGER          NOT NULL,
        spot      DOUBLE PRECISION,
        mark      DOUBLE PRECISION,
        last      DOUBLE PRECISION,
        bid       DOUBLE PRECISION,
        ask       DOUBLE PRECISION,
        bid_size  DOUBLE PRECISION,
        ask_size  DOUBLE PRECISION,
        mark_iv   DOUBLE PRECISION,
        bid_iv    DOUBLE PRECISION,
        ask_iv    DOUBLE PRECISION,
        delta     DOUBLE PRECISION,
        gamma     DOUBLE PRECISION,
        theta     DOUBLE PRECISION,
        vega      DOUBLE PRECISION,
        rho       DOUBLE PRECISION,
        oi        DOUBLE PRECISION,
        volume    DOUBLE PRECISION,
        PRIMARY KEY (at, symbol)
      );
      -- "this contract over the day": the other way into the table.
      CREATE INDEX IF NOT EXISTS option_snapshots_by_symbol ON option_snapshots (symbol, at);
    `,
  },
  {
    /*
     * The same rows a minute apart, six hours deep (22 Sep 2026).
     *
     * The five-minute record cannot answer "what has this premium done in the
     * last minute", which is the question the early warning and the 1m row on
     * "What changed" ask -- they showed dashes. A minute grain over a year
     * would be ~30 GB; over six hours it is ~20 MB, rolling.
     */
    id: 'market-008-option-snapshots-1m',
    up: `
      CREATE TABLE IF NOT EXISTS option_snapshots_1m (LIKE option_snapshots INCLUDING ALL);
    `,
  },
];

let ready: Promise<void> | null = null;
export function optionSnapshotsSchema(): Promise<void> {
  if (ready) return ready;
  ready = migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export type OptionSnapshotRow = {
  symbol: string; expiry: string; cp: 'C' | 'P'; strike: number;
  spot: number | null; mark: number | null; last: number | null;
  bid: number | null; ask: number | null; bidSize: number | null; askSize: number | null;
  markIv: number | null; bidIv: number | null; askIv: number | null;
  delta: number | null; gamma: number | null; theta: number | null; vega: number | null; rho: number | null;
  oi: number | null; volume: number | null;
};

/** The rows one snapshot would write: the nearest live expiries, every strike. Pure. */
export function snapshotRows(tickers: readonly Ticker[], nowSec: number, expiries = OPTION_SNAPSHOT_EXPIRIES): OptionSnapshotRow[] {
  const live = new Set<string>();
  const codes = [...new Set(tickers.map((t) => t.symbol.split('-').pop() ?? ''))]
    .filter((c) => /^\d{6}$/.test(c) && expiryTsOf(c) > nowSec)
    .sort((a, b) => expiryTsOf(a) - expiryTsOf(b))
    .slice(0, expiries);
  for (const c of codes) live.add(c);

  const out: OptionSnapshotRow[] = [];
  for (const t of tickers) {
    const expiry = t.symbol.split('-').pop() ?? '';
    const strike = num(t.strike_price);
    if (!live.has(expiry) || strike === null) continue;
    const cp = t.contract_type === 'call_options' ? 'C' : t.contract_type === 'put_options' ? 'P' : null;
    if (!cp) continue;
    const g = t.greeks;
    const q = t.quotes;
    out.push({
      symbol: t.symbol, expiry, cp, strike: Math.round(strike),
      spot: num(t.spot_price), mark: num(t.mark_price), last: num(t.close),
      bid: num(q?.best_bid), ask: num(q?.best_ask), bidSize: num(q?.bid_size), askSize: num(q?.ask_size),
      markIv: num(q?.mark_iv), bidIv: num(q?.bid_iv), askIv: num(q?.ask_iv),
      delta: num(g?.delta), gamma: num(g?.gamma), theta: num(g?.theta), vega: num(g?.vega), rho: num(g?.rho),
      oi: num(t.oi_contracts ?? t.oi), volume: num(t.volume),
    });
  }
  return out;
}

const COLS = ['symbol', 'expiry', 'cp', 'strike', 'spot', 'mark', 'last', 'bid', 'ask', 'bid_size', 'ask_size',
  'mark_iv', 'bid_iv', 'ask_iv', 'delta', 'gamma', 'theta', 'vega', 'rho', 'oi', 'volume'] as const;
const TYPES = ['text', 'text', 'text', 'int', 'float8', 'float8', 'float8', 'float8', 'float8', 'float8', 'float8',
  'float8', 'float8', 'float8', 'float8', 'float8', 'float8', 'float8', 'float8', 'float8', 'float8'] as const;
const PICK: ((r: OptionSnapshotRow) => unknown)[] = [
  (r) => r.symbol, (r) => r.expiry, (r) => r.cp, (r) => r.strike, (r) => r.spot, (r) => r.mark, (r) => r.last,
  (r) => r.bid, (r) => r.ask, (r) => r.bidSize, (r) => r.askSize, (r) => r.markIv, (r) => r.bidIv, (r) => r.askIv,
  (r) => r.delta, (r) => r.gamma, (r) => r.theta, (r) => r.vega, (r) => r.rho, (r) => r.oi, (r) => r.volume,
];

/**
 * Write one bucket, at most once. Returns the bucket written, or null when this
 * one is already on disk or there was nothing to write.
 *
 * Never throws: a disposable-looking side table that cannot write must not take
 * the desk with it. The failure is the caller's to log.
 */
export async function captureOptionSnapshots(
  tickers: readonly Ticker[],
  nowMs: number,
): Promise<{ at: number; rows: number } | null> {
  await optionSnapshotsSchema();
  const at = Math.floor(nowMs / OPTION_SNAPSHOT_BUCKET_MS) * OPTION_SNAPSHOT_BUCKET_MS;
  const minute = Math.floor(nowMs / OPTION_SNAPSHOT_1M_BUCKET_MS) * OPTION_SNAPSHOT_1M_BUCKET_MS;
  const fiveDone = Boolean(await one('SELECT 1 FROM option_snapshots WHERE at = $1 LIMIT 1', [at]));
  const minuteDone = Boolean(await one('SELECT 1 FROM option_snapshots_1m WHERE at = $1 LIMIT 1', [minute]));
  if (fiveDone && minuteDone) return null;
  const snap = snapshotRows(tickers, Math.floor(nowMs / 1000));
  if (!snap.length) return null;

  // One statement for the whole board: an array per column, unnested.
  const arrays = PICK.map((f) => snap.map(f));
  const sel = COLS.map((c, i) => `$${i + 2}::${TYPES[i]}[]`).join(', ');
  const write = (table: string, bucket: number) => query(
    `INSERT INTO ${table} (at, ${COLS.join(', ')})
     SELECT $1, * FROM unnest(${sel})
     ON CONFLICT (at, symbol) DO NOTHING`,
    [bucket, ...arrays] as never,
  );
  if (!fiveDone) {
    await write('option_snapshots', at);
    await query('DELETE FROM option_snapshots WHERE at < $1', [at - OPTION_SNAPSHOT_KEEP_MS]);
  }
  if (!minuteDone) {
    await write('option_snapshots_1m', minute);
    await query('DELETE FROM option_snapshots_1m WHERE at < $1', [minute - OPTION_SNAPSHOT_1M_KEEP_MS]);
  }
  return { at, rows: snap.length };
}

/**
 * When the newest five-minute record was written, for the screen's freshness
 * line. Memoised for half a minute: the chain asks every five seconds, and the
 * answer changes every five minutes.
 */
let lastAtMemo: { at: number | null; askedAt: number } | null = null;
/**
 * The newest record of either grain, for the screen's freshness bar.
 *
 * The minute record is the freshest evidence the desk holds, and both are
 * written by the same call -- so a bar reading five minutes while a record a
 * minute old sat beside it was saying the desk is staler than it is. Memoised
 * for half a minute: it is read on every board.
 */
export async function lastOptionSnapshotAt(nowMs = Date.now()): Promise<number | null> {
  if (lastAtMemo && nowMs - lastAtMemo.askedAt < 30_000) return lastAtMemo.at;
  const row = await one<{ at: number | null }>(
    'SELECT GREATEST(COALESCE((SELECT MAX(at) FROM option_snapshots), 0), COALESCE((SELECT MAX(at) FROM option_snapshots_1m), 0)) AS at',
  ).catch(() => null);
  lastAtMemo = { at: row?.at ? row.at : null, askedAt: nowMs };
  return lastAtMemo.at;
}

/** The newest bucket written, for the freshness gate and /api/health. */
export async function lastOptionSnapshot(): Promise<{ at: number; rows: number } | null> {
  await optionSnapshotsSchema();
  return one<{ at: number; rows: number }>(
    'SELECT at, COUNT(*)::int AS rows FROM option_snapshots WHERE at = (SELECT MAX(at) FROM option_snapshots) GROUP BY at',
  );
}
