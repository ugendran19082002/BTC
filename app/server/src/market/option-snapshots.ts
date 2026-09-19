import type { Ticker } from './delta.js';
import { expiryTsOf } from './chain.js';
import { migrate, type Migration } from '../db/migrate.js';
import { one, query, rows } from '../db/pool.js';

/**
 * Every strike of the traded expiries, every five minutes, kept for a year.
 *
 * Delta publishes greeks, IV and quotes live only (docs/Data.md §2); without
 * this, "how did the 78,000 call's IV and OI move through the morning" has no
 * answer after the fact. It is the raw layer: features (premium momentum, OI
 * acceleration, IV change) are derived from it, never stored instead of it, so
 * a feature thought of next month can still be computed over last month.
 *
 * Scope: the two nearest listed expiries -- today's contract and the one the
 * 05:30 entry sells -- every strike Delta lists for them. About 2.6 GB a year.
 */

export const OPTION_SNAPSHOT_BUCKET_MS = 5 * 60_000;
export const OPTION_SNAPSHOT_KEEP_MS = 365 * 24 * 3600_000;
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
  if (await one('SELECT 1 FROM option_snapshots WHERE at = $1 LIMIT 1', [at])) return null;
  const snap = snapshotRows(tickers, Math.floor(nowMs / 1000));
  if (!snap.length) return null;

  // One statement for the whole board: an array per column, unnested.
  const arrays = PICK.map((f) => snap.map(f));
  const sel = COLS.map((c, i) => `$${i + 2}::${TYPES[i]}[]`).join(', ');
  await query(
    `INSERT INTO option_snapshots (at, ${COLS.join(', ')})
     SELECT $1, * FROM unnest(${sel})
     ON CONFLICT (at, symbol) DO NOTHING`,
    [at, ...arrays] as never,
  );
  await query('DELETE FROM option_snapshots WHERE at < $1', [at - OPTION_SNAPSHOT_KEEP_MS]);
  return { at, rows: snap.length };
}

export type OptionHistoryPoint = {
  at: number; spot: number | null; mark: number | null; bid: number | null; ask: number | null;
  markIv: number | null; delta: number | null; oi: number | null; volume: number | null;
};

/** One contract over the last `hours`, oldest first. */
export async function optionHistory(symbol: string, sinceMs: number): Promise<OptionHistoryPoint[]> {
  await optionSnapshotsSchema();
  return (await rows<{
    at: number; spot: number | null; mark: number | null; bid: number | null; ask: number | null;
    mark_iv: number | null; delta: number | null; oi: number | null; volume: number | null;
  }>(
    `SELECT at, spot, mark, bid, ask, mark_iv, delta, oi, volume
       FROM option_snapshots WHERE symbol = $1 AND at >= $2 ORDER BY at`,
    [symbol, sinceMs],
  )).map((r) => ({ at: r.at, spot: r.spot, mark: r.mark, bid: r.bid, ask: r.ask, markIv: r.mark_iv, delta: r.delta, oi: r.oi, volume: r.volume }));
}

/** The newest bucket written, for the freshness gate and /api/health. */
export async function lastOptionSnapshot(): Promise<{ at: number; rows: number } | null> {
  await optionSnapshotsSchema();
  return one<{ at: number; rows: number }>(
    'SELECT at, COUNT(*)::int AS rows FROM option_snapshots WHERE at = (SELECT MAX(at) FROM option_snapshots) GROUP BY at',
  );
}
