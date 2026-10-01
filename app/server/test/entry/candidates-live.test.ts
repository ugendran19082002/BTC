import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../../src/market/delta.js';
import { LIVE_CANDIDATES, RESEARCH, barFlow } from '../../src/entry/methods.js';
import type { FlowMinute } from '../../src/entry/types.js';
import { ctxOf } from './bars.js';

/** The live-data research candidates: each reads the desk's live data, and says nothing when it is missing. */

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

test('the research track carries both kinds: candle candidates and live ones, each id once', () => {
  const ids = RESEARCH.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(LIVE_CANDIDATES.every((c) => ids.includes(c.id)));
  assert.ok(RESEARCH.every((m) => m.research === true));
});
