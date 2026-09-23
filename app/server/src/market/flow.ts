import { migrate, type Migration } from '../db/migrate.js';
import { one, query, rows } from '../db/pool.js';
import { req, type Ticker } from './delta.js';
import { FlowSocket, OPTION_SYMBOL, PERP_SYMBOL, perpTickerOf, type FlowHealth, type PerpTicker, type Print } from './flow-socket.js';
import { liveTickers } from './delta.js';
import { OPTION_SNAPSHOT_EXPIRIES } from './option-snapshots.js';
import { marketSchema } from './oi-history.js';

/**
 * The perpetual's order flow, the book and funding, recorded.
 *
 *   trade_flow_1m      every BTCUSD print, summed per minute by aggressor side
 *   option_flow_1m     every print on the two nearest expiries' options, per contract per minute, by aggressor side
 *   perp_snapshots     funding, open interest, turnover and the top of the book, every 5 minutes
 *
 * There was a fourth, `iv_term_snapshots`, for the IV term structure card's
 * "a week ago" lines. The card went on 22 September and the table with it
 * (`market-009`); the term structure itself is read live, from the tickers.
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
  {
    // How many large prints, not only their volume: the reference screen counts them.
    id: 'market-006-flow-large-counts',
    up: `
      ALTER TABLE trade_flow_1m ADD COLUMN IF NOT EXISTS large_buy_count  INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE trade_flow_1m ADD COLUMN IF NOT EXISTS large_sell_count INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // The options' own tape: who crossed the spread on each call and put, per minute. Delta's option
    // ticker carries volume but not the aggressor; only the prints do, so they are recorded.
    id: 'market-007-option-flow',
    up: `
      CREATE TABLE IF NOT EXISTS option_flow_1m (
        at          BIGINT           NOT NULL,
        symbol      TEXT             NOT NULL,
        expiry      TEXT             NOT NULL,
        cp          CHAR(1)          NOT NULL,
        strike      INTEGER          NOT NULL,
        buy_volume  DOUBLE PRECISION NOT NULL,
        sell_volume DOUBLE PRECISION NOT NULL,
        buy_count   INTEGER          NOT NULL,
        sell_count  INTEGER          NOT NULL,
        PRIMARY KEY (at, symbol)
      );
      CREATE INDEX IF NOT EXISTS option_flow_1m_expiry_at ON option_flow_1m (expiry, at);
    `,
  },
  {
    /*
     * The IV term record goes with the card that read it.
     *
     * `iv_term_snapshots` existed for one thing: the "a week ago / a month ago"
     * lines on the IV term structure card, removed from the Live screen on 22
     * September. Since then it was written every five minutes and read by
     * nobody, and `/api/term` was asking it two questions a minute per open
     * browser for numbers that went nowhere.
     *
     * The term structure itself is unaffected: it is read from the live
     * tickers, not from here. What is lost is the recorded history -- four
     * days of it -- so if the card ever comes back, its comparison lines start
     * again from the day it does.
     */
    id: 'market-009-drop-iv-term',
    up: 'DROP TABLE IF EXISTS iv_term_snapshots;',
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

/** The option contracts to watch: every strike of the nearest live expiries, from the ticker list already in memory. */
export function watchedOptionSymbols(tickers: readonly Ticker[], nowSec = Math.floor(Date.now() / 1000), expiries = OPTION_SNAPSHOT_EXPIRIES): string[] {
  const codes = [...new Set(tickers.map((t) => t.symbol.split('-').pop() ?? ''))]
    .filter((c) => /^\d{6}$/.test(c) && expiryTsOf(c) > nowSec)
    .sort((a, b) => expiryTsOf(a) - expiryTsOf(b))
    .slice(0, expiries);
  const live = new Set(codes);
  return tickers.map((t) => t.symbol).filter((sym) => OPTION_SYMBOL.test(sym) && live.has(sym.split('-').pop() ?? '')).sort();
}

/** Settlement, epoch seconds, of an expiry code DDMMYY: 17:30 IST that day. */
function expiryTsOf(code: string): number {
  const d = Number(code.slice(0, 2)), m = Number(code.slice(2, 4)), y = 2000 + Number(code.slice(4, 6));
  return Date.UTC(y, m - 1, d, 12, 0, 0) / 1000;
}

let watched: string[] = [];
export function startFlowSocket(log?: (line: string) => void): FlowSocket {
  if (socket) return socket;
  // The ticker list is refreshed elsewhere; here it is only read, and a fetch is kicked off for the first connect.
  const refresh = () => { liveTickers().then((t) => { watched = watchedOptionSymbols(t); }).catch(() => {}); };
  refresh();
  const timer = setInterval(refresh, 10 * 60_000);
  timer.unref?.();
  socket = new FlowSocket({ log, options: () => watched });
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
  largeBuyCount: number;
  largeSellCount: number;
  vwap: number | null;
  high: number | null;
  low: number | null;
};

/** The prints of one minute, summed. Pure. */
export function minuteOf(at: number, prints: readonly Print[], large = LARGE_PRINT_CONTRACTS): FlowMinute {
  const m: FlowMinute = { at, buyVolume: 0, sellVolume: 0, buyCount: 0, sellCount: 0, largeBuyVolume: 0, largeSellVolume: 0, largeBuyCount: 0, largeSellCount: 0, vwap: null, high: null, low: null };
  let notional = 0;
  for (const p of prints) {
    if (p.side === 'buy') { m.buyVolume += p.size; m.buyCount++; if (p.size >= large) { m.largeBuyVolume += p.size; m.largeBuyCount++; } }
    else { m.sellVolume += p.size; m.sellCount++; if (p.size >= large) { m.largeSellVolume += p.size; m.largeSellCount++; } }
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
  const all = socket.printsSince(since);
  const optionDone = optionMinutesOf(all.filter((p) => p.symbol)).filter((m) => m.at < current);
  if (optionDone.length) {
    await query(
      `INSERT INTO option_flow_1m (at, symbol, expiry, cp, strike, buy_volume, sell_volume, buy_count, sell_count)
       SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::int[], $6::float8[], $7::float8[], $8::int[], $9::int[])
       ON CONFLICT (at, symbol) DO NOTHING`,
      [
        optionDone.map((m) => m.at), optionDone.map((m) => m.symbol), optionDone.map((m) => m.expiry), optionDone.map((m) => m.cp), optionDone.map((m) => m.strike),
        optionDone.map((m) => m.buyVolume), optionDone.map((m) => m.sellVolume), optionDone.map((m) => m.buyCount), optionDone.map((m) => m.sellCount),
      ] as never,
    );
    await query('DELETE FROM option_flow_1m WHERE at < $1', [current - OPTION_FLOW_KEEP_MS]);
  }
  const done = minutesOf(all.filter((p) => !p.symbol)).filter((m) => m.at < current);
  if (!done.length) { if (optionDone.length) lastFlushedMinute = Math.max(lastFlushedMinute, optionDone[optionDone.length - 1]!.at); return optionDone.length; }
  await query(
    `INSERT INTO trade_flow_1m (at, buy_volume, sell_volume, buy_count, sell_count, large_buy_volume, large_sell_volume, vwap, high, low, large_buy_count, large_sell_count)
     SELECT * FROM unnest($1::bigint[], $2::float8[], $3::float8[], $4::int[], $5::int[], $6::float8[], $7::float8[], $8::float8[], $9::float8[], $10::float8[], $11::int[], $12::int[])
     ON CONFLICT (at) DO NOTHING`,
    [
      done.map((m) => m.at), done.map((m) => m.buyVolume), done.map((m) => m.sellVolume),
      done.map((m) => m.buyCount), done.map((m) => m.sellCount),
      done.map((m) => m.largeBuyVolume), done.map((m) => m.largeSellVolume),
      done.map((m) => m.vwap), done.map((m) => m.high), done.map((m) => m.low),
      done.map((m) => m.largeBuyCount), done.map((m) => m.largeSellCount),
    ] as never,
  );
  lastFlushedMinute = done[done.length - 1]!.at;
  await query('DELETE FROM trade_flow_1m WHERE at < $1', [current - FLOW_KEEP_MS]);
  return done.length + optionDone.length;
}

// ------------------------------------------------------- the options' tape

/** Option prints are kept for a month: the screen reads an hour, the record is for the research history. */
export const OPTION_FLOW_KEEP_MS = 31 * 24 * 3600_000;

export type OptionMinute = { at: number; symbol: string; expiry: string; cp: 'C' | 'P'; strike: number; buyVolume: number; sellVolume: number; buyCount: number; sellCount: number };

/** Option prints grouped per contract per minute, oldest first. Pure. */
export function optionMinutesOf(prints: readonly Print[]): OptionMinute[] {
  const groups = new Map<string, OptionMinute>();
  for (const p of prints) {
    const m = p.symbol ? OPTION_SYMBOL.exec(p.symbol) : null;
    if (!m) continue;
    const at = Math.floor(p.at / FLOW_BUCKET_MS) * FLOW_BUCKET_MS;
    const key = `${at}|${p.symbol}`;
    const row = groups.get(key) ?? { at, symbol: p.symbol!, expiry: m[3]!, cp: m[1] as 'C' | 'P', strike: Number(m[2]), buyVolume: 0, sellVolume: 0, buyCount: 0, sellCount: 0 };
    if (p.side === 'buy') { row.buyVolume += p.size; row.buyCount++; } else { row.sellVolume += p.size; row.sellCount++; }
    groups.set(key, row);
  }
  return [...groups.values()].sort((a, b) => a.at - b.at || a.symbol.localeCompare(b.symbol));
}

export type SideFlow = {
  buyVolume: number;
  sellVolume: number;
  deltaVolume: number;
  trades: number;
  /** Buy volume as a share of the total; null with no prints. */
  aggressorBuyPct: number | null;
  /** What the tape says about this side: takers lifting offers (buying) or hitting bids (selling), or nothing clear. */
  pressure: 'BUY PRESSURE' | 'SELL PRESSURE' | 'BALANCED' | null;
  /** The busiest strikes on this side over the window, most volume first. */
  strikes: { strike: number; buyVolume: number; sellVolume: number }[];
  /** Cumulative volume delta, minute by minute over the window. */
  cvd: { at: number; cvd: number; delta: number }[];
};

export type OptionFlowSummary = {
  expiry: string;
  windowMin: number;
  /** Minutes in the window with at least one option print on this expiry. */
  minutesCovered: number;
  ce: SideFlow;
  pe: SideFlow;
  /** CE and PE together, and which way the whole board's takers lean. */
  combined: { buyVolume: number; sellVolume: number; deltaVolume: number; bias: 'CALL BUYING' | 'CALL SELLING' | 'PUT BUYING' | 'PUT SELLING' | 'MIXED' | null };
  source: 'socket' | 'none';
};

/** Buy against sell, per side, from `minutes` of one expiry. Pure. */
export function optionFlowOf(expiry: string, windowMin: number, minutes: readonly OptionMinute[]): OptionFlowSummary {
  const side = (cp: 'C' | 'P'): SideFlow => {
    const mine = minutes.filter((m) => m.cp === cp);
    const byStrike = new Map<number, { strike: number; buyVolume: number; sellVolume: number }>();
    const f: SideFlow = { buyVolume: 0, sellVolume: 0, deltaVolume: 0, trades: 0, aggressorBuyPct: null, pressure: null, strikes: [], cvd: [] };
    const byMinute = new Map<number, number>();
    for (const m of mine) {
      f.buyVolume += m.buyVolume; f.sellVolume += m.sellVolume; f.trades += m.buyCount + m.sellCount;
      byMinute.set(m.at, (byMinute.get(m.at) ?? 0) + m.buyVolume - m.sellVolume);
      const k = byStrike.get(m.strike) ?? { strike: m.strike, buyVolume: 0, sellVolume: 0 };
      k.buyVolume += m.buyVolume; k.sellVolume += m.sellVolume; byStrike.set(m.strike, k);
    }
    f.deltaVolume = f.buyVolume - f.sellVolume;
    const total = f.buyVolume + f.sellVolume;
    f.aggressorBuyPct = total > 0 ? f.buyVolume / total : null;
    // Past 55 / 45 the tape leans; inside it, it does not say.
    f.pressure = f.aggressorBuyPct === null ? null : f.aggressorBuyPct >= 0.55 ? 'BUY PRESSURE' : f.aggressorBuyPct <= 0.45 ? 'SELL PRESSURE' : 'BALANCED';
    f.strikes = [...byStrike.values()].sort((a, b) => (b.buyVolume + b.sellVolume) - (a.buyVolume + a.sellVolume)).slice(0, 3);
    let run = 0;
    for (const [at, delta] of [...byMinute.entries()].sort((a, b) => a[0] - b[0])) { run += delta; f.cvd.push({ at, cvd: run, delta }); }
    return f;
  };
  const ce = side('C'), pe = side('P');
  const buyVolume = ce.buyVolume + pe.buyVolume, sellVolume = ce.sellVolume + pe.sellVolume;
  // The heavier side of the heavier leg names the bias; a board that is not leaning is mixed.
  const legs = [
    { name: 'CALL BUYING' as const, v: ce.buyVolume }, { name: 'CALL SELLING' as const, v: ce.sellVolume },
    { name: 'PUT BUYING' as const, v: pe.buyVolume }, { name: 'PUT SELLING' as const, v: pe.sellVolume },
  ].sort((a, b) => b.v - a.v);
  const total = buyVolume + sellVolume;
  const bias = total <= 0 ? null : legs[0]!.v / total >= 0.4 ? legs[0]!.name : 'MIXED';
  return {
    expiry, windowMin, minutesCovered: new Set(minutes.map((m) => m.at)).size, ce, pe,
    combined: { buyVolume, sellVolume, deltaVolume: buyVolume - sellVolume, bias },
    source: minutes.length ? 'socket' : 'none',
  };
}

/** The options' tape on one expiry over the last `windowMin` minutes: the recorded minutes plus the ones the socket still holds. */
export async function optionFlowSummary(expiry: string, windowMin = 60, nowMs = Date.now()): Promise<OptionFlowSummary> {
  await flowSchema();
  const current = Math.floor(nowMs / FLOW_BUCKET_MS) * FLOW_BUCKET_MS;
  const since = current - (windowMin - 1) * FLOW_BUCKET_MS;
  const stored = (await rows<{ at: number; symbol: string; expiry: string; cp: 'C' | 'P'; strike: number; buy_volume: number; sell_volume: number; buy_count: number; sell_count: number }>(
    'SELECT * FROM option_flow_1m WHERE expiry = $1 AND at >= $2 AND at < $3 ORDER BY at, symbol', [expiry, since, current],
  )).map<OptionMinute>((r) => ({ at: r.at, symbol: r.symbol, expiry: r.expiry, cp: r.cp, strike: r.strike, buyVolume: r.buy_volume, sellVolume: r.sell_volume, buyCount: r.buy_count, sellCount: r.sell_count }));
  const have = new Set(stored.map((m) => `${m.at}|${m.symbol}`));
  const held = socket ? optionMinutesOf(socket.printsSince(since).filter((p) => p.symbol?.endsWith(`-${expiry}`))).filter((m) => !have.has(`${m.at}|${m.symbol}`)) : [];
  return optionFlowOf(expiry, windowMin, [...stored, ...held]);
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
  /** Prints of `LARGE_PRINT_CONTRACTS` or more. */
  largeTrades: number;
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
    large_buy_volume: number; large_sell_volume: number; large_buy_count: number; large_sell_count: number;
    vwap: number | null; high: number | null; low: number | null;
  }>('SELECT * FROM trade_flow_1m WHERE at >= $1 AND at < $2 ORDER BY at', [since, current]))
    .map<FlowMinute>((r) => ({
      at: r.at, buyVolume: r.buy_volume, sellVolume: r.sell_volume, buyCount: r.buy_count, sellCount: r.sell_count,
      largeBuyVolume: r.large_buy_volume, largeSellVolume: r.large_sell_volume, largeBuyCount: r.large_buy_count, largeSellCount: r.large_sell_count,
      vwap: r.vwap, high: r.high, low: r.low,
    }));
  // Minutes the socket holds that are not written yet (the current one, and any the flush has not reached).
  const have = new Set(stored.map((m) => m.at));
  const held = socket ? minutesOf(socket.printsSince(since)).filter((m) => !have.has(m.at)) : [];
  const minutes = [...stored, ...held].sort((a, b) => a.at - b.at);

  const s: FlowSummary = {
    windowMin, minutesCovered: minutes.length,
    buyVolume: 0, sellVolume: 0, deltaVolume: 0, totalVolume: 0, trades: 0, avgTradeSize: null,
    largeBuyVolume: 0, largeSellVolume: 0, largeTrades: 0, aggressorBuyPct: null, cvd: [],
    source: minutes.length ? 'socket' : 'none',
  };
  let cvd = 0;
  for (const m of minutes) {
    s.buyVolume += m.buyVolume; s.sellVolume += m.sellVolume;
    s.trades += m.buyCount + m.sellCount;
    s.largeBuyVolume += m.largeBuyVolume; s.largeSellVolume += m.largeSellVolume;
    s.largeTrades += m.largeBuyCount + m.largeSellCount;
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
/** The current ATM IV against every reading `chain_features` holds: the IV percentile, with how long the record is. */
export async function ivRank(atmIv: number | null): Promise<SkewRank | null> {
  if (atmIv === null) return null;
  await marketSchema();
  const r = await one<{ n: number; below: number; oldest: number | null }>(
    `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE atm_iv < $1)::int AS below, MIN(at) AS oldest
       FROM chain_features WHERE atm_iv IS NOT NULL`,
    [atmIv],
  );
  if (!r || r.n < 12 || r.oldest === null) return null;
  return { percentile: r.below / r.n, samples: r.n, days: (Date.now() - r.oldest) / 86_400_000 };
}

export type OiPulse = {
  /** The board's open-interest change over the last hour, calls and puts, contracts. */
  ceChange1h: number | null;
  peChange1h: number | null;
  /** The same reading an hour earlier: the change of the change. Positive, positioning is speeding up. */
  ceAcceleration: number | null;
  peAcceleration: number | null;
  /** The hour's OI change as a share of the side's open interest. */
  ceOiChange1hPct: number | null;
  peOiChange1hPct: number | null;
  /** The at-the-money call's and put's mark against an hour ago, percent: premium pressure a side at a time. */
  ceAtmMarkChange1hPct: number | null;
  peAtmMarkChange1hPct: number | null;
  at: number | null;
};

/** OI change and its acceleration for one expiry, from the five-minute board record. */
export async function oiPulse(expiry: string, nowMs = Date.now()): Promise<OiPulse> {
  await marketSchema();
  type Row = { at: number; ce: number | null; pe: number | null; ce_oi: number | null; pe_oi: number | null; call_atm: number | null; put_atm: number | null };
  const latest = await one<Row>(
    'SELECT at, ce_oi_change AS ce, pe_oi_change AS pe, ce_oi, pe_oi, call_atm, put_atm FROM chain_features WHERE expiry = $1 AND at <= $2 ORDER BY at DESC LIMIT 1',
    [expiry, nowMs],
  );
  const none: OiPulse = { ceChange1h: null, peChange1h: null, ceAcceleration: null, peAcceleration: null, ceOiChange1hPct: null, peOiChange1hPct: null, ceAtmMarkChange1hPct: null, peAtmMarkChange1hPct: null, at: null };
  if (!latest) return none;
  const before = await one<Row>(
    'SELECT at, ce_oi_change AS ce, pe_oi_change AS pe, ce_oi, pe_oi, call_atm, put_atm FROM chain_features WHERE expiry = $1 AND at BETWEEN $2 AND $3 ORDER BY ABS(at - $4) LIMIT 1',
    [expiry, latest.at - 70 * 60_000, latest.at - 50 * 60_000, latest.at - 60 * 60_000],
  );
  const acc = (a: number | null, b: number | null | undefined) => (a === null || b === null || b === undefined ? null : a - b);
  const pct = (now: number | null, then: number | null | undefined) => (now === null || then === null || then === undefined || then === 0 ? null : (now / then - 1) * 100);
  const share = (change: number | null, oi: number | null) => (change === null || oi === null || oi === 0 ? null : (change / oi) * 100);
  return {
    ceChange1h: latest.ce, peChange1h: latest.pe,
    ceAcceleration: acc(latest.ce, before?.ce), peAcceleration: acc(latest.pe, before?.pe),
    ceOiChange1hPct: share(latest.ce, latest.ce_oi), peOiChange1hPct: share(latest.pe, latest.pe_oi),
    ceAtmMarkChange1hPct: pct(latest.call_atm, before?.call_atm), peAtmMarkChange1hPct: pct(latest.put_atm, before?.put_atm),
    at: latest.at,
  };
}

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
