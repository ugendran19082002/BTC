import { migrate, type Migration } from '../db/migrate.js';
import { query, rows } from '../db/pool.js';
import { candles, type Candle } from '../market/delta.js';
import { runTrend, trendR, trendStop, type TrendBar, type TrendState } from './trend-breakout.js';

/**
 * The trend plan's paper log: the forward test the backtest cannot be.
 *
 * Every five minutes the plan (trend-breakout.ts, the same code the chart and
 * the study run) is replayed on closed 1H candles from a fixed start, and on
 * 4H candles folded from them; every trade it has taken is written once and
 * kept up to date -- its stop as it trails, then its exit and result after
 * taker fees. Nothing is ordered: it is a record of what the plan would have
 * done, as it happened.
 *
 * **Live or replayed.** A trade is `live` when this recorder first saw it
 * within fifteen minutes of the close that made it -- it was on the log before
 * anyone knew how it would end. A trade first written later (the recorder was
 * down, or a fresh database replayed the history) is kept, but apart: only the
 * live trades are the forward test.
 *
 * The fixed start (1 Sep 2026) makes the replay the same on every restart: one
 * position at a time means a later start could otherwise take other trades.
 */

export const TREND_PAPER_START = Date.UTC(2026, 8, 1) / 1000;
const FEE_PER_SIDE = 0.0005;
const LIVE_WITHIN_S = 15 * 60;
const H = 3600;

const MIGRATIONS: Migration[] = [
  {
    id: 'trend-001-paper',
    up: `
      CREATE TABLE IF NOT EXISTS trend_paper (
        tf          TEXT             NOT NULL,
        entry_time  BIGINT           NOT NULL,
        dir         SMALLINT         NOT NULL,
        entry       DOUBLE PRECISION NOT NULL,
        stop0       DOUBLE PRECISION NOT NULL,
        risk        DOUBLE PRECISION NOT NULL,
        stop        DOUBLE PRECISION NOT NULL,
        exit_time   BIGINT,
        exit        DOUBLE PRECISION,
        r_net       DOUBLE PRECISION,
        first_seen  BIGINT           NOT NULL,
        live        BOOLEAN          NOT NULL,
        updated_at  BIGINT           NOT NULL,
        PRIMARY KEY (tf, entry_time)
      );
    `,
  },
];

let ready: Promise<void> | null = null;
export function trendPaperSchema(): Promise<void> {
  if (ready) return ready;
  ready = migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

/** Complete `sec` buckets folded from 1H candles, oldest first. Pure. */
export function fold(hours: readonly TrendBar[], sec: number): TrendBar[] {
  const out: TrendBar[] = [];
  const per = sec / H;
  for (let i = 0; i < hours.length;) {
    const start = Math.floor(hours[i]!.time / sec) * sec;
    const group: TrendBar[] = [];
    while (i < hours.length && Math.floor(hours[i]!.time / sec) * sec === start) group.push(hours[i++]!);
    if (group.length !== per || group[0]!.time !== start) continue;
    out.push({ time: start, open: group[0]!.open, close: group[per - 1]!.close, high: Math.max(...group.map((b) => b.high)), low: Math.min(...group.map((b) => b.low)) });
  }
  return out;
}

export type PaperRow = {
  tf: string; entryTime: number; dir: 1 | -1; entry: number; stop0: number; risk: number; stop: number;
  exitTime: number | null; exit: number | null; rNet: number | null;
};

/** The replay's trades as rows: times are the signal / exit candles' close, seconds. Pure. */
export function paperRows(tf: string, st: TrendState, bars: readonly TrendBar[], sec: number): PaperRow[] {
  return st.trades.map((t) => {
    const closed = t.exitAt !== null && t.exit !== null;
    const r = closed ? trendR(t)! - ((t.entry + t.exit!) * FEE_PER_SIDE) / t.risk : null;
    return {
      tf, entryTime: bars[t.at]!.time + sec, dir: t.dir, entry: t.entry, stop0: t.stop0, risk: t.risk, stop: trendStop(t),
      exitTime: closed ? bars[t.exitAt!]!.time + sec : null, exit: closed ? t.exit : null, rNet: r,
    };
  });
}

/** Write the rows: new ones once (with when they were first seen, and whether that was live), open ones kept current. */
export async function writePaper(list: readonly PaperRow[], nowSec: number): Promise<number> {
  await trendPaperSchema();
  let written = 0;
  for (const r of list) {
    const live = nowSec - r.entryTime <= LIVE_WITHIN_S;
    const res = await query(
      `INSERT INTO trend_paper (tf, entry_time, dir, entry, stop0, risk, stop, exit_time, exit, r_net, first_seen, live, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $11)
       ON CONFLICT (tf, entry_time) DO UPDATE SET stop = EXCLUDED.stop, exit_time = EXCLUDED.exit_time, exit = EXCLUDED.exit,
         r_net = EXCLUDED.r_net, updated_at = EXCLUDED.updated_at
       WHERE trend_paper.exit_time IS NULL
         AND (trend_paper.stop IS DISTINCT FROM EXCLUDED.stop OR trend_paper.exit_time IS DISTINCT FROM EXCLUDED.exit_time)`,
      [r.tf, r.entryTime, r.dir, r.entry, r.stop0, r.risk, r.stop, r.exitTime, r.exit, r.rNet, nowSec, live],
    );
    written += res.rowCount ?? 0;
  }
  return written;
}

let hours: TrendBar[] = [];

/** The closed 1H candles from the start, fetched in pieces; after the first call only the new ones. */
async function closedHours(nowSec: number, fetch: typeof candles): Promise<TrendBar[]> {
  const lastClosed = Math.floor(nowSec / H) * H - H; // the newest candle whose hour is over
  let from = hours.length ? hours[hours.length - 1]!.time + H : TREND_PAPER_START;
  while (from <= lastClosed) {
    const to = Math.min(lastClosed + H - 1, from + 1_000 * H);
    const got: Candle[] = await fetch('BTCUSD', from, to, '1h');
    for (const c of got) if (c.time >= from && c.time <= lastClosed && (!hours.length || c.time > hours[hours.length - 1]!.time)) hours.push(c);
    from = to + 1;
  }
  return hours;
}

/** One pass: replay 1H and 4H from the start and write what changed. Returns the rows written. */
export async function recordTrendPaper(nowMs = Date.now(), fetch: typeof candles = candles): Promise<number> {
  const nowSec = Math.floor(nowMs / 1000);
  const h1 = await closedHours(nowSec, fetch);
  if (h1.length < 25) return 0;
  const h4 = fold(h1, 4 * H);
  const list = [...paperRows('1H', runTrend(h1), h1, H), ...(h4.length >= 25 ? paperRows('4H', runTrend(h4), h4, 4 * H) : [])];
  return writePaper(list, nowSec);
}

/** For tests: forget the fetched candles. */
export function resetTrendPaper(): void { hours = []; }

export type PaperSummary = { tf: string; live: number; closed: number; open: number; wins: number; netR: number; replayed: number };

/** The log: the latest trades and, per timeframe, the live forward test's count and result. */
export async function trendPaper(limit = 50): Promise<{ since: number; trades: (PaperRow & { live: boolean; firstSeen: number })[]; summary: PaperSummary[] }> {
  await trendPaperSchema();
  const all = await rows<{ tf: string; entry_time: number; dir: number; entry: number; stop0: number; risk: number; stop: number; exit_time: number | null; exit: number | null; r_net: number | null; first_seen: number; live: boolean }>(
    'SELECT * FROM trend_paper ORDER BY entry_time DESC',
  );
  const summary: PaperSummary[] = ['1H', '4H'].map((tf) => {
    const mine = all.filter((r) => r.tf === tf);
    const live = mine.filter((r) => r.live);
    const closed = live.filter((r) => r.r_net !== null);
    return {
      tf, live: live.length, closed: closed.length, open: live.length - closed.length,
      wins: closed.filter((r) => r.r_net! > 0).length, netR: closed.reduce((a, r) => a + r.r_net!, 0),
      replayed: mine.length - live.length,
    };
  });
  return {
    since: TREND_PAPER_START,
    trades: all.slice(0, limit).map((r) => ({
      tf: r.tf, entryTime: Number(r.entry_time), dir: r.dir as 1 | -1, entry: r.entry, stop0: r.stop0, risk: r.risk, stop: r.stop,
      exitTime: r.exit_time === null ? null : Number(r.exit_time), exit: r.exit, rNet: r.r_net, live: r.live, firstSeen: Number(r.first_seen),
    })),
    summary,
  };
}
