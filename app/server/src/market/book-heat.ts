import { migrate, type Migration } from '../db/migrate.js';
import { query, rows } from '../db/pool.js';
import { req } from './delta.js';
import { PERP_SYMBOL } from './flow-socket.js';

/**
 * The perpetual's resting liquidity, recorded: the chart's heatmap.
 *
 *   book_heat_1m   the order book every ten seconds, contracts resting in each
 *                  $10 of price, averaged over the minute -- one row a minute
 *
 * The book is read from REST (500 levels a side, about ±1.2% around price,
 * some 8 KB gzipped), not the socket: a snapshot every ten seconds is all a
 * minute's average needs. Averaging is deliberate: an order that flashes for
 * one snapshot and is pulled shows at a sixth of its size, and one resting
 * all minute shows at full -- the heatmap is about liquidity that stays.
 *
 * What it is not: the whole market's liquidity (one exchange's visible book),
 * or a promise (resting orders are cancelled and moved). The chart says so.
 */

export const HEAT_STEP = 10;
export const HEAT_SAMPLE_MS = 10_000;
export const HEAT_DEPTH = 500;
export const HEAT_KEEP_MS = 14 * 24 * 3_600_000;
const MINUTE = 60_000;

const MIGRATIONS: Migration[] = [
  {
    id: 'market-016-book-heat',
    up: `
      CREATE TABLE IF NOT EXISTS book_heat_1m (
        at       BIGINT           PRIMARY KEY,
        base     DOUBLE PRECISION NOT NULL,
        step     REAL             NOT NULL,
        bid      REAL[]           NOT NULL,
        ask      REAL[]           NOT NULL,
        samples  SMALLINT         NOT NULL,
        best_bid DOUBLE PRECISION,
        best_ask DOUBLE PRECISION
      );
    `,
  },
];

let ready: Promise<void> | null = null;
export function bookHeatSchema(): Promise<void> {
  if (ready) return ready;
  ready = migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

type L2 = { buy?: { size: number; price: string }[]; sell?: { size: number; price: string }[] };

/** One snapshot of the book: contracts resting in each `step` bin (keyed floor(price / step)), each side. */
export type BookSample = { at: number; bid: Map<number, number>; ask: Map<number, number>; bestBid: number | null; bestAsk: number | null };

/** The exchange's book as one binned sample. Pure. */
export function sampleOf(l2: L2, at: number, step = HEAT_STEP): BookSample {
  const bin = (levels: { size: number; price: string }[] | undefined) => {
    const out = new Map<number, number>();
    for (const l of levels ?? []) {
      const price = Number(l.price);
      const size = Number(l.size);
      if (!(price > 0) || !(size > 0)) continue;
      const k = Math.floor(price / step);
      out.set(k, (out.get(k) ?? 0) + size);
    }
    return out;
  };
  const bestBid = l2.buy?.length ? Number(l2.buy[0]!.price) : null;
  const bestAsk = l2.sell?.length ? Number(l2.sell[0]!.price) : null;
  return { at, bid: bin(l2.buy), ask: bin(l2.sell), bestBid, bestAsk };
}

/** A minute of the book: each bin's size averaged over its samples, `base` the lowest bin's price. */
export type HeatMinute = { at: number; base: number; step: number; bid: number[]; ask: number[]; samples: number; bestBid: number | null; bestAsk: number | null };

/** The samples of one minute as one row; a bin missing from a sample counts as empty then. Null with no samples. Pure. */
export function minuteOfSamples(at: number, samples: readonly BookSample[], step = HEAT_STEP): HeatMinute | null {
  if (!samples.length) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of samples) for (const m of [s.bid, s.ask]) for (const k of m.keys()) { lo = Math.min(lo, k); hi = Math.max(hi, k); }
  if (!Number.isFinite(lo)) return null;
  const n = hi - lo + 1;
  const bid = new Array<number>(n).fill(0);
  const ask = new Array<number>(n).fill(0);
  for (const s of samples) {
    for (const [k, v] of s.bid) bid[k - lo]! += v / samples.length;
    for (const [k, v] of s.ask) ask[k - lo]! += v / samples.length;
  }
  const last = samples[samples.length - 1]!;
  return { at, base: lo * step, step, bid, ask, samples: samples.length, bestBid: last.bestBid, bestAsk: last.bestAsk };
}

// ------------------------------------------------------------ the sampler

let held: BookSample[] = [];
let lastWritten = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/** One read of the book, kept in memory until its minute is written. A failed read is skipped: the minute averages what it has. */
export async function sampleBook(now = Date.now(), fetchL2: () => Promise<L2 | null> = () => req<L2>(`/l2orderbook/${PERP_SYMBOL}?depth=${HEAT_DEPTH}`, 1)): Promise<boolean> {
  const l2 = await fetchL2().catch(() => null);
  if (!l2) return false;
  held.push(sampleOf(l2, now));
  const keepFrom = Math.floor(now / MINUTE) * MINUTE - 3 * MINUTE;
  held = held.filter((s) => s.at >= keepFrom);
  return true;
}

export function startBookHeat(): void {
  if (timer) return;
  timer = setInterval(() => { void sampleBook(); }, HEAT_SAMPLE_MS);
  timer.unref?.();
}

/** For tests: forget the samples and what was written. */
export function resetBookHeat(): void { held = []; lastWritten = 0; }

/** The held samples as minutes, oldest first, with the minute in progress last. */
function heldMinutes(): HeatMinute[] {
  const by = new Map<number, BookSample[]>();
  for (const s of held) {
    const at = Math.floor(s.at / MINUTE) * MINUTE;
    (by.get(at) ?? by.set(at, []).get(at)!).push(s);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([at, ss]) => minuteOfSamples(at, ss)!).filter(Boolean);
}

/** Write every completed minute not written yet. Idempotent. Returns the minutes written. */
export async function flushBookHeat(now = Date.now()): Promise<number> {
  await bookHeatSchema();
  const current = Math.floor(now / MINUTE) * MINUTE;
  const done = heldMinutes().filter((m) => m.at < current && m.at > lastWritten);
  for (const m of done) {
    await query(
      `INSERT INTO book_heat_1m (at, base, step, bid, ask, samples, best_bid, best_ask)
       VALUES ($1, $2, $3, $4::real[], $5::real[], $6, $7, $8) ON CONFLICT (at) DO NOTHING`,
      [m.at, m.base, m.step, m.bid.map(round1), m.ask.map(round1), m.samples, m.bestBid, m.bestAsk],
    );
    lastWritten = m.at;
  }
  if (done.length) await query('DELETE FROM book_heat_1m WHERE at < $1', [current - HEAT_KEEP_MS]);
  return done.length;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

// ------------------------------------------------------------ reading

/** Every minute from `sinceMs`: the recorded ones, then the held ones not written yet (the minute in progress last). */
export async function heatMinutes(sinceMs: number): Promise<HeatMinute[]> {
  await bookHeatSchema();
  const saved = (await rows<{ at: number; base: number; step: number; bid: number[]; ask: number[]; samples: number; best_bid: number | null; best_ask: number | null }>(
    'SELECT * FROM book_heat_1m WHERE at >= $1 ORDER BY at', [sinceMs],
  )).map<HeatMinute>((r) => ({ at: Number(r.at), base: r.base, step: r.step, bid: r.bid, ask: r.ask, samples: r.samples, bestBid: r.best_bid, bestAsk: r.best_ask }));
  const have = new Set(saved.map((m) => m.at));
  return [...saved, ...heldMinutes().filter((m) => m.at >= sinceMs && !have.has(m.at))];
}

/** One minute re-binned to `step` (a multiple of the recorded step): bin index (floor(price / step)) → contracts, each side. Pure. */
function rebin(m: HeatMinute, step: number): { bid: Map<number, number>; ask: Map<number, number> } {
  const out = { bid: new Map<number, number>(), ask: new Map<number, number>() };
  for (const side of ['bid', 'ask'] as const) {
    m[side].forEach((v, i) => {
      if (!(v > 0)) return;
      const k = Math.floor((m.base + i * m.step) / step);
      out[side].set(k, (out[side].get(k) ?? 0) + v);
    });
  }
  return out;
}

/** A candle's column: [bin index, contracts] cells, bids and asks together (they do not overlap), faint ones left out. */
export type HeatColumn = { time: number; cells: [number, number][] };

/**
 * Minutes folded into `tfSec` candles at `step` dollars a bin: each bin's size
 * averaged over the candle's recorded minutes. Cells under 2% of the column's
 * largest are left out -- they would draw as nothing and cost bytes. Pure.
 */
export function heatColumnsOf(minutes: readonly HeatMinute[], tfSec: number, step: number): HeatColumn[] {
  const by = new Map<number, HeatMinute[]>();
  for (const m of minutes) {
    const time = Math.floor(m.at / 1000 / tfSec) * tfSec;
    (by.get(time) ?? by.set(time, []).get(time)!).push(m);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([time, ms]) => {
    const sum = new Map<number, number>();
    for (const m of ms) {
      const r = rebin(m, step);
      for (const side of [r.bid, r.ask]) for (const [k, v] of side) sum.set(k, (sum.get(k) ?? 0) + v / ms.length);
    }
    const max = Math.max(0, ...sum.values());
    const cells = [...sum.entries()].filter(([, v]) => v >= max * 0.02).sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, Math.round(v)] as [number, number]);
    return { time, cells };
  });
}

/** A level of resting size that has stayed: where, how much now (contracts), and for how many minutes running. */
export type Wall = { side: 'bid' | 'ask'; price: number; size: number; minutes: number };

/** A bin is a wall in a minute when it holds three times the side's median non-empty bin. */
const WALL_X_MEDIAN = 3;
/** And persistent when it has been one for this many minutes running, up to now. */
const WALL_MINUTES = 5;

/**
 * The persistent walls now, from minutes oldest first (the last one is now):
 * bins that are walls in the latest minute and were in each of the minutes
 * before it for at least five running. The three biggest a side. Pure.
 */
export function persistentWalls(minutes: readonly HeatMinute[], step: number): Wall[] {
  if (!minutes.length) return [];
  const walls = minutes.map((m) => {
    const r = rebin(m, step);
    const pick = (side: Map<number, number>) => {
      const vals = [...side.values()].filter((v) => v > 0).sort((a, b) => a - b);
      const median = vals[Math.floor(vals.length / 2)] ?? Infinity;
      return new Map([...side].filter(([, v]) => v >= WALL_X_MEDIAN * median));
    };
    return { bid: pick(r.bid), ask: pick(r.ask) };
  });
  const out: Wall[] = [];
  for (const side of ['bid', 'ask'] as const) {
    const now = walls[walls.length - 1]![side];
    const found: Wall[] = [];
    for (const [k, size] of now) {
      let run = 0;
      for (let i = walls.length - 1; i >= 0 && walls[i]![side].has(k); i--) run++;
      if (run >= WALL_MINUTES) found.push({ side, price: (k + 0.5) * step, size: Math.round(size), minutes: run });
    }
    out.push(...found.sort((a, b) => b.size - a.size).slice(0, 3));
  }
  return out;
}
