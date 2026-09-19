import { migrate, type Migration } from '../db/migrate.js';
import { one, query, rows } from '../db/pool.js';
import { req, type Ticker } from './delta.js';
import { FlowSocket, PERP_SYMBOL, perpTickerOf, type FlowHealth, type PerpTicker, type Print } from './flow-socket.js';
import { termStructure, type TermPoint } from './term.js';
import { marketSchema } from './oi-history.js';

/**
 * The perpetual's order flow, the book, funding and the IV term structure,
 * recorded -- the three tables docs/test.md §10 asks for, and the history the
 * Live screen's "a week ago" lines need.
 *
 *   trade_flow_1m      every BTCUSD print, summed per minute by aggressor side
 *   perp_snapshots     funding, open interest, turnover and the top of the book, every 5 minutes
 *   iv_term_snapshots  ATM IV per listed expiry, every 5 minutes
 *
 * The prints come off the socket (`flow-socket.ts`); the book and, when the
 * socket is quiet, the perp ticker come from REST. Every reader here says how
 * much of its window it actually has (`minutesCovered`): a summary over a
 * window the socket was away for is not dressed up as a full hour.
 */

export const FLOW_BUCKET_MS = 60_000;
export const FLOW_KEEP_MS = 365 * 24 * 3600_000;
export const PERP_BUCKET_MS = 5 * 60_000;
/** A print of this many contracts or more is a large trade: 0.2 BTC, about $16,000 at $80,000. */
export const LARGE_PRINT_CONTRACTS = 200;
/** Book depth read from the exchange, levels a side. */
export const BOOK_DEPTH = 20;

const MIGRATIONS: Migration[] = [
  {
    id: 'market-005-flow',
    up: `
      CREATE TABLE IF NOT EXISTS trade_flow_1m (
        at                BIGINT           PRIMARY KEY,
        buy_volume        DOUBLE PRECISION NOT NULL,
        sell_volume       DOUBLE PRECISION NOT NULL,
        buy_count         INTEGER          NOT NULL,
        sell_count        INTEGER          NOT NULL,
        large_buy_volume  DOUBLE PRECISION NOT NULL,
        large_sell_volume DOUBLE PRECISION NOT NULL,
        vwap              DOUBLE PRECISION,
        high              DOUBLE PRECISION,
        low               DOUBLE PRECISION
      );
      CREATE TABLE IF NOT EXISTS perp_snapshots (
        at               BIGINT PRIMARY KEY,
        mark             DOUBLE PRECISION,
        spot             DOUBLE PRECISION,
        funding_rate     DOUBLE PRECISION,
        oi_contracts     DOUBLE PRECISION,
        oi_usd           DOUBLE PRECISION,
        turnover_usd_24h DOUBLE PRECISION,
        volume_24h       DOUBLE PRECISION,
        bid_depth        DOUBLE PRECISION,
        ask_depth        DOUBLE PRECISION,
        imbalance        DOUBLE PRECISION,
        spread           DOUBLE PRECISION
      );
      CREATE TABLE IF NOT EXISTS iv_term_snapshots (
        at         BIGINT           NOT NULL,
        expiry     TEXT             NOT NULL,
        hours_away DOUBLE PRECISION NOT NULL,
        strike     INTEGER          NOT NULL,
        atm_iv     DOUBLE PRECISION NOT NULL,
        PRIMARY KEY (at, expiry)
      );
    `,
  },
];

let ready: Promise<void> | null = null;
export function flowSchema(): Promise<void> {
  if (ready) return ready;
  ready = migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

// ------------------------------------------------------------------- the feed

let socket: FlowSocket | null = null;

export function startFlowSocket(log?: (line: string) => void): FlowSocket {
  if (socket) return socket;
  socket = new FlowSocket({ log });
  socket.start();
  return socket;
}

export function stopFlowSocket(): void {
  socket?.stop();
  socket = null;
}

/** For tests: read from this feed instead of the live one. */
export function useFlowSocket(s: FlowSocket | null): void { socket = s; }

export function flowFeedHealth(): FlowHealth {
  return socket?.health() ?? { source: 'none', connected: false, lastMessageAt: null, prints: 0, reconnects: 0 };
}

// ------------------------------------------------------------ minute rows

export type FlowMinute = {
  at: number;
  buyVolume: number;
  sellVolume: number;
  buyCount: number;
  sellCount: number;
  largeBuyVolume: number;
  largeSellVolume: number;
  vwap: number | null;
  high: number | null;
  low: number | null;
};

/** The prints of one minute, summed. Pure. */
export function minuteOf(at: number, prints: readonly Print[], large = LARGE_PRINT_CONTRACTS): FlowMinute {
  const m: FlowMinute = { at, buyVolume: 0, sellVolume: 0, buyCount: 0, sellCount: 0, largeBuyVolume: 0, largeSellVolume: 0, vwap: null, high: null, low: null };
  let notional = 0;
  for (const p of prints) {
    if (p.side === 'buy') { m.buyVolume += p.size; m.buyCount++; if (p.size >= large) m.largeBuyVolume += p.size; }
    else { m.sellVolume += p.size; m.sellCount++; if (p.size >= large) m.largeSellVolume += p.size; }
    notional += p.price * p.size;
    m.high = m.high === null ? p.price : Math.max(m.high, p.price);
    m.low = m.low === null ? p.price : Math.min(m.low, p.price);
  }
  const vol = m.buyVolume + m.sellVolume;
  m.vwap = vol > 0 ? notional / vol : null;
  return m;
}

/** Prints grouped into the minutes they printed in, oldest first. Pure. */
export function minutesOf(prints: readonly Print[], large = LARGE_PRINT_CONTRACTS): FlowMinute[] {
  const groups = new Map<number, Print[]>();
  for (const p of prints) {
    const at = Math.floor(p.at / FLOW_BUCKET_MS) * FLOW_BUCKET_MS;
    (groups.get(at) ?? groups.set(at, []).get(at)!).push(p);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([at, ps]) => minuteOf(at, ps, large));
}

let lastFlushedMinute = 0;

/**
 * Write every completed minute the socket holds that is not on disk yet.
 * Idempotent: a minute already written is left alone, so a restart that
 * replays the snapshot cannot double a bar. Returns the minutes written.
 */
export async function flushTradeFlow(nowMs: number): Promise<number> {
  if (!socket) return 0;
  await flowSchema();
  const current = Math.floor(nowMs / FLOW_BUCKET_MS) * FLOW_BUCKET_MS;
  const since = Math.max(lastFlushedMinute + FLOW_BUCKET_MS, current - 60 * FLOW_BUCKET_MS);
  const done = minutesOf(socket.printsSince(since)).filter((m) => m.at < current);
  if (!done.length) return 0;
  await query(
    `INSERT INTO trade_flow_1m (at, buy_volume, sell_volume, buy_count, sell_count, large_buy_volume, large_sell_volume, vwap, high, low)
     SELECT * FROM unnest($1::bigint[], $2::float8[], $3::float8[], $4::int[], $5::int[], $6::float8[], $7::float8[], $8::float8[], $9::float8[], $10::float8[])
     ON CONFLICT (at) DO NOTHING`,
    [
      done.map((m) => m.at), done.map((m) => m.buyVolume), done.map((m) => m.sellVolume),
      done.map((m) => m.buyCount), done.map((m) => m.sellCount),
      done.map((m) => m.largeBuyVolume), done.map((m) => m.largeSellVolume),
      done.map((m) => m.vwap), done.map((m) => m.high), done.map((m) => m.low),
    ] as never,
  );
  lastFlushedMinute = done[done.length - 1]!.at;
  await query('DELETE FROM trade_flow_1m WHERE at < $1', [current - FLOW_KEEP_MS]);
  return done.length;
}

export type FlowSummary = {
  /** The window asked for, in minutes, and how many of them have at least one print. */
  windowMin: number;
  minutesCovered: number;
  /** Contracts. */
  buyVolume: number;
  sellVolume: number;
  deltaVolume: number;
  totalVolume: number;
  trades: number;
  avgTradeSize: number | null;
  largeBuyVolume: number;
  largeSellVolume: number;
  /** Buy volume as a share of the total: above a half, buyers are lifting offers. */
  aggressorBuyPct: number | null;
  /** Cumulative volume delta, one point per minute, oldest first. */
  cvd: { at: number; cvd: number; delta: number }[];
  /** Where the prints came from: the socket, or nothing (window empty). */
  source: 'socket' | 'none';
};

/** Buy against sell over the last `windowMin` minutes: the recorded minutes plus the one in progress. */
export async function flowSummary(windowMin = 60, nowMs = Date.now()): Promise<FlowSummary> {
  await flowSchema();
  const current = Math.floor(nowMs / FLOW_BUCKET_MS) * FLOW_BUCKET_MS;
  const since = current - (windowMin - 1) * FLOW_BUCKET_MS;
  const stored = (await rows<{
    at: number; buy_volume: number; sell_volume: number; buy_count: number; sell_count: number;
    large_buy_volume: number; large_sell_volume: number; vwap: number | null; high: number | null; low: number | null;
  }>('SELECT * FROM trade_flow_1m WHERE at >= $1 AND at < $2 ORDER BY at', [since, current]))
    .map<FlowMinute>((r) => ({
      at: r.at, buyVolume: r.buy_volume, sellVolume: r.sell_volume, buyCount: r.buy_count, sellCount: r.sell_count,
      largeBuyVolume: r.large_buy_volume, largeSellVolume: r.large_sell_volume, vwap: r.vwap, high: r.high, low: r.low,
    }));
  // Minutes the socket holds that are not written yet (the current one, and any the flush has not reached).
  const have = new Set(stored.map((m) => m.at));
  const held = socket ? minutesOf(socket.printsSince(since)).filter((m) => !have.has(m.at)) : [];
  const minutes = [...stored, ...held].sort((a, b) => a.at - b.at);

  const s: FlowSummary = {
    windowMin, minutesCovered: minutes.length,
    buyVolume: 0, sellVolume: 0, deltaVolume: 0, totalVolume: 0, trades: 0, avgTradeSize: null,
    largeBuyVolume: 0, largeSellVolume: 0, aggressorBuyPct: null, cvd: [],
    source: minutes.length ? 'socket' : 'none',
  };
  let cvd = 0;
  for (const m of minutes) {
    s.buyVolume += m.buyVolume; s.sellVolume += m.sellVolume;
    s.trades += m.buyCount + m.sellCount;
    s.largeBuyVolume += m.largeBuyVolume; s.largeSellVolume += m.largeSellVolume;
    const d = m.buyVolume - m.sellVolume;
    cvd += d;
    s.cvd.push({ at: m.at, cvd, delta: d });
  }
  s.totalVolume = s.buyVolume + s.sellVolume;
  s.deltaVolume = s.buyVolume - s.sellVolume;
  s.avgTradeSize = s.trades ? s.totalVolume / s.trades : null;
  s.aggressorBuyPct = s.totalVolume > 0 ? s.buyVolume / s.totalVolume : null;
  return s;
}

// ------------------------------------------------------------ perp and book

export type BookSnapshot = {
  at: number;
  /** Contracts resting within `BOOK_DEPTH` levels of the touch, each side. */
  bidDepth: number;
  askDepth: number;
  /** (bid − ask) / (bid + ask): positive, more resting to buy. */
  imbalance: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spreadUsd: number | null;
  spreadPct: number | null;
  top5Bid: number;
  top5Ask: number;
};

type L2 = { buy?: { size: number; price: string }[]; sell?: { size: number; price: string }[]; last_updated_at?: number };

/** The book as a snapshot. Pure. */
export function bookOf(l2: L2, at: number): BookSnapshot {
  const bids = l2.buy ?? [];
  const asks = l2.sell ?? [];
  const sum = (xs: { size: number }[], n = xs.length) => xs.slice(0, n).reduce((a, x) => a + (Number(x.size) || 0), 0);
  const bidDepth = sum(bids), askDepth = sum(asks);
  const bestBid = bids[0] ? Number(bids[0].price) : null;
  const bestAsk = asks[0] ? Number(asks[0].price) : null;
  const spreadUsd = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  return {
    at, bidDepth, askDepth,
    imbalance: bidDepth + askDepth > 0 ? (bidDepth - askDepth) / (bidDepth + askDepth) : null,
    bestBid, bestAsk, spreadUsd,
    spreadPct: spreadUsd !== null && bestBid !== null && bestBid > 0 ? spreadUsd / bestBid : null,
    top5Bid: sum(bids, 5), top5Ask: sum(asks, 5),
  };
}

const BOOK_TTL_MS = 5_000;
let bookCache: BookSnapshot | null = null;
let bookInflight: Promise<BookSnapshot | null> | null = null;

/** The top of the perp's book, at most `BOOK_TTL_MS` old. One fetch at a time, however many ask. */
export async function liveBook(nowMs = Date.now()): Promise<BookSnapshot | null> {
  if (bookCache && nowMs - bookCache.at < BOOK_TTL_MS) return bookCache;
  if (bookInflight) return bookInflight;
  bookInflight = (async () => {
    try {
      const l2 = await req<L2>(`/l2orderbook/${PERP_SYMBOL}?depth=${BOOK_DEPTH}`, 2);
      if (l2) bookCache = bookOf(l2, Date.now());
      return bookCache;
    } finally {
      bookInflight = null;
    }
  })();
  return bookInflight;
}

const PERP_TTL_MS = 10_000;
let perpRest: PerpTicker | null = null;

/** The perp ticker: the socket's when it is fresh, REST otherwise. */
export async function livePerp(nowMs = Date.now()): Promise<PerpTicker | null> {
  const fromSocket = socket?.fresh(nowMs) ? socket.perpTicker() : null;
  if (fromSocket) return fromSocket;
  if (perpRest && nowMs - perpRest.at < PERP_TTL_MS) return perpRest;
  const t = await req<Record<string, unknown>>(`/tickers/${PERP_SYMBOL}`, 2);
  if (t) perpRest = perpTickerOf({ ...t, symbol: PERP_SYMBOL }, Date.now());
  return perpRest;
}

/** One five-minute bucket of funding, OI, turnover and the book. Idempotent per bucket. */
export async function capturePerpSnapshot(nowMs: number): Promise<{ at: number } | null> {
  await flowSchema();
  const at = Math.floor(nowMs / PERP_BUCKET_MS) * PERP_BUCKET_MS;
  if (await one('SELECT 1 FROM perp_snapshots WHERE at = $1', [at])) return null;
  const [t, b] = await Promise.all([livePerp(nowMs), liveBook(nowMs)]);
  if (!t && !b) return null;
  await query(
    `INSERT INTO perp_snapshots (at, mark, spot, funding_rate, oi_contracts, oi_usd, turnover_usd_24h, volume_24h, bid_depth, ask_depth, imbalance, spread)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (at) DO NOTHING`,
    [at, t?.mark ?? null, t?.spot ?? null, t?.fundingRate ?? null, t?.oiContracts ?? null, t?.oiUsd ?? null,
      t?.turnoverUsd24h ?? null, t?.volume24h ?? null, b?.bidDepth ?? null, b?.askDepth ?? null, b?.imbalance ?? null, b?.spreadUsd ?? null],
  );
  await query('DELETE FROM perp_snapshots WHERE at < $1', [at - FLOW_KEEP_MS]);
  return { at };
}

// ------------------------------------------------------------ term history

/** One five-minute bucket of the term structure. Idempotent per bucket. */
export async function captureIvTerm(tickers: readonly Ticker[], nowMs: number): Promise<{ at: number; rows: number } | null> {
  await flowSchema();
  const at = Math.floor(nowMs / PERP_BUCKET_MS) * PERP_BUCKET_MS;
  if (await one('SELECT 1 FROM iv_term_snapshots WHERE at = $1 LIMIT 1', [at])) return null;
  const pts = termStructure(tickers, Math.floor(nowMs / 1000));
  if (!pts.length) return null;
  await query(
    `INSERT INTO iv_term_snapshots (at, expiry, hours_away, strike, atm_iv)
     SELECT $1, * FROM unnest($2::text[], $3::float8[], $4::int[], $5::float8[])
     ON CONFLICT (at, expiry) DO NOTHING`,
    [at, pts.map((p) => p.expiry), pts.map((p) => p.hoursAway), pts.map((p) => p.strike), pts.map((p) => p.atmIv)] as never,
  );
  await query('DELETE FROM iv_term_snapshots WHERE at < $1', [at - FLOW_KEEP_MS]);
  return { at, rows: pts.length };
}

export type TermHistoryPoint = Pick<TermPoint, 'expiry' | 'hoursAway' | 'strike' | 'atmIv'>;

/**
 * The term structure as it was `agoMs` ago: the bucket nearest that instant,
 * within an hour of it. Null when the desk was not recording then -- a line
 * from a week ago needs a week of recording, and there is no other source.
 */
export async function termHistory(agoMs: number, nowMs = Date.now()): Promise<{ at: number; points: TermHistoryPoint[] } | null> {
  await flowSchema();
  const target = nowMs - agoMs;
  const near = await one<{ at: number }>(
    'SELECT at FROM iv_term_snapshots WHERE at BETWEEN $1 AND $2 ORDER BY ABS(at - $3) LIMIT 1',
    [target - 3_600_000, target + 3_600_000, target],
  );
  if (!near) return null;
  const pts = await rows<{ expiry: string; hours_away: number; strike: number; atm_iv: number }>(
    'SELECT expiry, hours_away, strike, atm_iv FROM iv_term_snapshots WHERE at = $1 ORDER BY hours_away',
    [near.at],
  );
  return { at: near.at, points: pts.map((p) => ({ expiry: p.expiry, hoursAway: p.hours_away, strike: p.strike, atmIv: p.atm_iv })) };
}

// -------------------------------------------------------------- skew history

export type SkewRank = {
  /** Where today's skew sits among every recorded reading, 0–1. */
  percentile: number;
  samples: number;
  /** How far back the record goes, in days. */
  days: number;
};

/**
 * The current put−call skew against every reading `chain_features` holds.
 * The reference screens call it the one-year percentile; the desk has been
 * recording since 17 Sep 2026, and says how long its record actually is.
 */
export async function skewRank(nowPts: number | null): Promise<SkewRank | null> {
  if (nowPts === null) return null;
  await marketSchema();
  const r = await one<{ n: number; below: number; oldest: number | null }>(
    `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE iv_skew_pts < $1)::int AS below, MIN(at) AS oldest
       FROM chain_features WHERE iv_skew_pts IS NOT NULL`,
    [nowPts],
  );
  if (!r || r.n < 12 || r.oldest === null) return null;
  return { percentile: r.below / r.n, samples: r.n, days: (Date.now() - r.oldest) / 86_400_000 };
}
