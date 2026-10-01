import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../../src/market/delta.js';
import { LIVE_CANDIDATES, METHODS, barFlow } from '../../src/entry/methods.js';
import type { FlowMinute } from '../../src/entry/types.js';
import { ctxOf } from './bars.js';

/** The live-data methods: each reads the desk's live data, and says nothing when it is missing. */

const T = 1_790_640_000; // a minute boundary
const m1 = (k: number, o: number, h: number, l: number, c: number): Candle => ({ time: T + 60 * k, open: o, high: h, low: l, close: c, volume: 1 });
const flat = (n: number, px = 84_000) => Array.from({ length: n }, (_, k) => m1(k, px, px + 5, px - 5, px));
const det = (id: string) => LIVE_CANDIDATES.find((c) => c.id === id)!.detect;

test('the tape per bar: a 1m bar is its minute; a bar with its minutes missing is null, never zero', () => {
  const bars = flat(3);
  const flow: FlowMinute[] = [{ time: T, buy: 10, sell: 4, largeBuy: 5, largeSell: 0 }, { time: T + 60, buy: 1, sell: 9, largeBuy: 0, largeSell: 2 }];
  const f = barFlow(bars, ctxOf({ flow }));
  assert.deepEqual(f[0], { delta: 6, volume: 14, large: 5 });
  assert.deepEqual(f[1], { delta: -8, volume: 10, large: -2 });
  assert.equal(f[2], null);
});

test('[critical] with no tape, no quote, no option board, every live candidate says nothing -- never a guess', () => {
  const bars = flat(60);
  for (const c of LIVE_CANDIDATES) assert.equal(c.detect({ bars, a: 20, trend: 0, ctx: ctxOf({ flow: [], options: null, quote: null, ltp: null }) }), null, c.id);
});

test('[critical] basis: the perpetual 0.08% over the index, turning down, is a short back toward the index', () => {
  const bars = [...flat(20), m1(20, 84_000, 84_010, 83_950, 83_960)];
  bars[19] = m1(19, 84_000, 84_020, 83_990, 84_010);
  const now = (T + 21 * 60) * 1000;
  const ctx = ctxOf({ now, ltp: { price: 84_100, at: now - 1_000 }, quote: { mark: 84_090, index: 84_000, at: now - 1_000 } });
  const s = det('basis')({ bars, a: 20, trend: 0, ctx })!;
  assert.equal(s.dir, -1);
  assert.equal(s.targets![0]!.price, 84_000);
  // A stale quote is not read.
  assert.equal(det('basis')({ bars, a: 20, trend: 0, ctx: ctxOf({ now, ltp: { price: 84_100, at: 0 }, quote: { mark: 84_090, index: 84_000, at: 0 } }) }), null);
});

test('[critical] expiry pin: within two hours of settlement, away from max pain, turning toward it -- and not before then', () => {
  const bars = [...flat(20, 84_200), m1(20, 84_200, 84_205, 84_150, 84_160)];
  bars[19] = m1(19, 84_200, 84_210, 84_190, 84_200);
  const opts = (toSettleSec: number) => ({ spot: 84_160, atmIv: 0.4, emDay: 1_000, callWall: null, putWall: null, maxPain: 84_000, toSettleSec });
  const s = det('expiry-pin')({ bars, a: 60, trend: 0, ctx: ctxOf({ options: opts(3_600) }) })!;
  assert.deepEqual([s.dir, s.targets![0]!.price], [-1, 84_000]);
  assert.equal(det('expiry-pin')({ bars, a: 60, trend: 0, ctx: ctxOf({ options: opts(20_000) }) }), null, 'five hours out: no pin');
});

test('every live-data method is on the desk, like the twelve', () => {
  const ids = METHODS.map((m) => m.id);
  assert.ok(LIVE_CANDIDATES.every((c) => ids.includes(c.id)));
});

// ------------------------------------------------------------ the derivatives history, the book, the footprint, the regime
import { regimeOf } from '../../src/entry/methods.js';
import { path, wave } from './bars.js';

const breakoutUp = () => { const bars = flat(22); bars[21] = m1(21, 84_000, 84_080, 83_995, 84_070); return bars; };

test('[critical] OI-confirmed breakout: a 20-bar break with open interest building -- and not with it falling', () => {
  const perp = (oi0: number, oi1: number) => ({ perp: [
    { at: T * 1000, mark: 84_000, index: 84_000, funding: 0.01, oi: oi0, imbalance: 0 },
    { at: (T + 30 * 60) * 1000, mark: 84_070, index: 84_060, funding: 0.01, oi: oi1, imbalance: 0 },
  ], board: { now: [], before: [] }, iv: [], expiries: [] });
  const det2 = det('oi-breakout');
  assert.equal(det2({ bars: breakoutUp(), a: 20, trend: 0, ctx: ctxOf({ deriv: perp(800_000, 804_000) }) })!.dir, 1, 'OI +0.5%');
  assert.equal(det2({ bars: breakoutUp(), a: 20, trend: 0, ctx: ctxOf({ deriv: perp(800_000, 796_000) }) }), null, 'OI falling: short covering, not new positions');
});

test('[critical] microprice: the top of the book leaning up by a third of the spread, and the bar closing through the one before', () => {
  const bars = flat(3); bars[2] = m1(2, 84_000, 84_030, 83_998, 84_025);
  const now = (T + 3 * 60) * 1000;
  const book = (bid: number, ask: number) => ({ at: now - 1_000, bestBid: 84_020, bestAsk: 84_030, top5Bid: bid, top5Ask: ask, imbalance: 0 });
  assert.equal(det('microprice')({ bars, a: 20, trend: 0, ctx: ctxOf({ now, book: book(900, 100) }) })!.dir, 1);
  assert.equal(det('microprice')({ bars, a: 20, trend: 0, ctx: ctxOf({ now, book: book(500, 500) }) }), null, 'no lean');
});

test('[critical] footprint: three or more $10 levels in a row bought 3x in a bar that closed high is a continuation long', () => {
  const bar = m1(5, 84_000, 84_060, 83_995, 84_055), bars = [...flat(5), bar];
  const prints = [84_010, 84_020, 84_030, 84_040].flatMap((px, k) => Array.from({ length: 6 }, (_, j) => ({ at: (bar.time + k * 10 + j) * 1000, price: px + 2, size: 10, side: 'buy' as const })));
  prints.push({ at: (bar.time + 50) * 1000, price: 84_012, size: 5, side: 'sell' });
  const s = det('stacked-continuation')({ bars, a: 20, trend: 0, ctx: ctxOf({ prints }) })!;
  assert.equal(s.dir, 1);
  assert.match(s.steps[0]!.label, /^4 levels in a row bought 3x/);
});

test('the regime is read on every series: efficiency, volatility and volume z, autocorrelation -- null where it cannot be', () => {
  const bars = path(wave(260, 84_000, 60, 12), { w: 5 }).map((b, k) => ({ ...b, volume: 100 + (k % 7) * 15 }));
  const g = regimeOf(bars, ctxOf({ frames: { '5m': bars } }));
  for (const k of ['efficiency', 'volZ', 'volumeZ', 'autocorr'] as const) assert.ok(g[k] !== null && Number.isFinite(g[k]), k);
  assert.equal(g.frontOiShift, null, 'no option board');
  assert.equal(g.ethCorr, null, 'no ETH');
});
