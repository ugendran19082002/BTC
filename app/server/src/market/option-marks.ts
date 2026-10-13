import { candles as deltaCandles, type Candle } from './delta.js';
import { OPTION_SNAPSHOT_KEEP_MS, optionSnapshotsSchema } from './option-snapshots.js';
import { migrate, type Migration } from '../db/migrate.js';
import { one, query, rows } from '../db/pool.js';

/**
 * Delta's own one-minute mark price of the contracts the desk recorded only every five minutes (owner, 13 Oct
 * 2026: "backtest on one-minute option prices; where the database has none, take them from Delta's API").
 *
 * The desk's one-minute board (`option_snapshots_1m`) was a rolling six hours until that day, so for every expiry
 * day before it the finest record is the five-minute one. Delta serves no past bid or offer, but it does serve
 * each contract's mark a minute at a time (`MARK:<contract>`, docs/reference/market-data.md "Historical"), for
 * settled contracts too. Kept here, a minute between two five-minute readings is no longer a guess at a stale
 * quote: the mark is Delta's own, and only the spread around it is carried from the last reading the desk has.
 * Measured on six hours where both exist (13 Oct 2026, 13 contracts, 2,459 minutes): the bid so estimated was
 * $2.07 from the real one on average, the five-minute reading $4.41; the worst one in a hundred $15 against $34.
 *
 * One request a contract a day (1,440 candles; Delta gives up to 2,000), unsigned, a few a second at most and a
 * bounded number a run: this is history, never worth a slow order.
 *
 * Only settled expiry days, and only the contracts that could have been sold -- out of the money with a bid worth
 * selling at some reading. A contract asked for once is never asked for again, candles or none.
 */

/** A day is not fetched while the desk's own minute record covers this share of it. */
export const OWN_MINUTES_ENOUGH = 0.9;
/** The lowest bid a contract must have shown to be worth fetching: the backtest's own floor. */
const SELLABLE_BID = 10;

const MIGRATIONS: Migration[] = [
  {
    id: 'market-018-option-marks-1m',
    up: `
      CREATE TABLE IF NOT EXISTS option_marks_1m (
        symbol  TEXT             NOT NULL,
        at      BIGINT           NOT NULL,
        open    DOUBLE PRECISION NOT NULL,
        high    DOUBLE PRECISION NOT NULL,
        low     DOUBLE PRECISION NOT NULL,
        close   DOUBLE PRECISION NOT NULL,
        PRIMARY KEY (symbol, at)
      );
      -- Which contracts have been asked for, with how many candles came back: none is an answer too.
      CREATE TABLE IF NOT EXISTS option_marks_fetched (
        symbol      TEXT    PRIMARY KEY,
        expiry      TEXT    NOT NULL,
        candles     INTEGER NOT NULL,
        fetched_at  BIGINT  NOT NULL
      );
      CREATE INDEX IF NOT EXISTS option_marks_fetched_by_expiry ON option_marks_fetched (expiry);
    `,
  },
];

let ready: Promise<void> | null = null;
export function optionMarksSchema(): Promise<void> {
  if (ready) return ready;
  ready = Promise.all([optionSnapshotsSchema(), migrate(MIGRATIONS)]).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

const codeOf = (day: string) => `${day.slice(8, 10)}${day.slice(5, 7)}${day.slice(2, 4)}`;

/** The contracts of one expiry day still to fetch: sellable at some reading, not asked for yet. Empty where the desk's own minutes cover the day. */
export async function marksWanted(day: string, span: { from: number; to: number }): Promise<string[]> {
  await optionMarksSchema();
  const expiry = codeOf(day);
  const own = await one<{ n: number }>('SELECT COUNT(DISTINCT at)::int AS n FROM option_snapshots_1m WHERE expiry = $1 AND at >= $2 AND at < $3', [expiry, span.from, span.to]);
  if ((own?.n ?? 0) >= OWN_MINUTES_ENOUGH * (span.to - span.from) / 60_000) return [];
  const want = await rows<{ symbol: string }>(
    `SELECT DISTINCT s.symbol FROM option_snapshots s
      WHERE s.expiry = $1 AND s.at >= $2 AND s.at <= $3 AND s.bid >= $4 AND s.spot IS NOT NULL
        AND ((s.cp = 'P' AND s.strike < s.spot) OR (s.cp = 'C' AND s.strike > s.spot))
        AND NOT EXISTS (SELECT 1 FROM option_marks_fetched f WHERE f.symbol = s.symbol)
      ORDER BY s.symbol`, [expiry, span.from, span.to, SELLABLE_BID]);
  return want.map((x) => x.symbol);
}

/** One contract's minutes, written once. Returns how many candles there were. */
export async function storeMarks(symbol: string, expiry: string, cs: readonly Candle[], nowMs: number): Promise<number> {
  const ok = cs.filter((c) => [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v >= 0) && Number.isFinite(c.time));
  if (ok.length) {
    await query(
      `INSERT INTO option_marks_1m (symbol, at, open, high, low, close)
       SELECT $1, * FROM unnest($2::bigint[], $3::float8[], $4::float8[], $5::float8[], $6::float8[])
       ON CONFLICT (symbol, at) DO NOTHING`,
      [symbol, ok.map((c) => c.time * 1_000), ok.map((c) => c.open), ok.map((c) => c.high), ok.map((c) => c.low), ok.map((c) => c.close)] as never,
    );
  }
  await query(
    `INSERT INTO option_marks_fetched (symbol, expiry, candles, fetched_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (symbol) DO UPDATE SET candles = EXCLUDED.candles, fetched_at = EXCLUDED.fetched_at`,
    [symbol, expiry, ok.length, nowMs],
  );
  return ok.length;
}

export type MarksRun = { days: number; contracts: number; candles: number; left: number };

let running = false;

/**
 * A bounded run of the fetch: the settled expiry days given, newest first, a contract at a time with a pause
 * between, at most `maxRequests` of them. It stops at once when `busy` says the desk has better things to ask
 * Delta. Never throws: a request that fails is left for the next run. One run at a time.
 */
export async function fetchOptionMarks(o: {
  /** The expiry days to cover, with their spans; those still running are skipped. */
  days: readonly { day: string; from: number; to: number }[];
  now?: number;
  maxRequests?: number;
  pauseMs?: number;
  busy?: () => boolean;
  /** Delta's candles; a test passes its own. */
  fetch?: (symbol: string, startSec: number, endSec: number) => Promise<Candle[]>;
  onError?: (e: Error) => void;
}): Promise<MarksRun> {
  const out: MarksRun = { days: 0, contracts: 0, candles: 0, left: 0 };
  if (running) return out;
  running = true;
  try {
    await optionMarksSchema();
    const now = o.now ?? Date.now();
    const fetch = o.fetch ?? ((s, a, b) => deltaCandles(`MARK:${s}`, a, b));
    let budget = o.maxRequests ?? 120;
    // Past what the five-minute record itself keeps there is nothing to put a minute between.
    await query('DELETE FROM option_marks_1m WHERE at < $1', [now - OPTION_SNAPSHOT_KEEP_MS]);
    for (const d of [...o.days].filter((x) => x.to <= now).sort((a, b) => b.to - a.to)) {
      const want = await marksWanted(d.day, d);
      if (!want.length) continue;
      out.days++;
      for (let i = 0; i < want.length; i++) {
        if (budget <= 0 || o.busy?.()) { out.left += want.length - i; break; }
        budget--;
        try {
          // The day's own span and no more: the contract's last candle is the minute before it settles.
          out.candles += await storeMarks(want[i]!, codeOf(d.day), await fetch(want[i]!, Math.floor((d.from - 5 * 60_000) / 1_000), Math.floor(d.to / 1_000)), now);
          out.contracts++;
        } catch (e) {
          o.onError?.(e as Error);
          out.left += want.length - i;
          break;
        }
        if (o.pauseMs !== 0) await new Promise((r) => setTimeout(r, o.pauseMs ?? 400));
      }
    }
    return out;
  } finally {
    running = false;
  }
}

/** How much of each expiry is fetched: contracts asked for, and candles kept. For the backtest's cache and its "priced on" line. */
export async function marksFetchedBy(expiries: readonly string[]): Promise<Map<string, { contracts: number; candles: number }>> {
  await optionMarksSchema();
  const out = new Map<string, { contracts: number; candles: number }>();
  if (!expiries.length) return out;
  const r = await rows<{ expiry: string; contracts: number; candles: number }>(
    'SELECT expiry, COUNT(*)::int AS contracts, COALESCE(SUM(candles), 0)::int AS candles FROM option_marks_fetched WHERE expiry = ANY($1::text[]) GROUP BY expiry', [expiries as string[]] as never);
  for (const x of r) out.set(x.expiry, { contracts: x.contracts, candles: x.candles });
  return out;
}
