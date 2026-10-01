import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../../src/market/delta.js';
import { CANDIDATES, prevDay, valueArea, weekVwap } from '../../src/entry/candidates.js';
import { atr } from '../../src/entry/prims.js';
import { ctxOf, path, wave } from './bars.js';

/** The candidate methods' pieces: research only until one passes scripts/methods-study.ts. */

const D = 1_790_726_400; // 2026-09-30 00:00 UTC, a Wednesday
const hour = (t: number, lo: number, hi: number): Candle => ({ time: t, open: lo, high: hi, low: lo, close: hi, volume: 10 });

test('the previous UTC day: all 24 hours or nothing', () => {
  const h1 = Array.from({ length: 30 }, (_, k) => hour(D - 24 * 3600 + k * 3600, 84_000 + k, 84_100 + k));
  assert.deepEqual(prevDay(h1, D + 5 * 3600), { hi: 84_123, lo: 84_000 });
  assert.equal(prevDay(h1.slice(1), D + 5 * 3600), null, 'a missing hour: no day');
});

test('a volume profile: the POC where most volume traded, a value area holding 70% around it', () => {
  const bars = Array.from({ length: 120 }, (_, k): Candle => {
    const at = k < 80 ? 84_050 : 84_300; // two thirds of the volume at 84,050
    return { time: D + k * 300, open: at, high: at + 10, low: at - 10, close: at, volume: 100 };
  });
  const va = valueArea(bars, 25)!;
  assert.ok(va.poc > 84_000 && va.poc < 84_100, `POC ${va.poc}`);
  assert.ok(va.val <= 84_040 && va.vah >= 84_060);
  assert.equal(valueArea(bars.slice(0, 50)), null, 'too few bars');
});

test("the week's anchored VWAP starts on Monday 00:00 UTC", () => {
  const monday = D - 2 * 86_400;
  const h1 = Array.from({ length: 40 }, (_, k) => hour(monday - 5 * 3600 + k * 3600, 84_000, 84_000));
  h1.forEach((b, k) => { if (b.time < monday) { b.high = b.low = b.close = b.open = 90_000; } else { b.high = b.low = b.close = b.open = 84_000 + k; } });
  const v = weekVwap(h1, monday + 30 * 3600)!;
  assert.ok(v > 84_000 && v < 84_040, `only this week's hours count: ${v}`);
});

test('every candidate reads a long ordinary series without throwing, and any setup it gives is whole', () => {
  const bars = path(wave(600, 84_000, 60, 12));
  const ctx = ctxOf({ frames: { '5m': bars } });
  const a = atr(bars)!;
  for (const c of CANDIDATES) {
    const s = c.detect({ bars, a, trend: 0, ctx });
    if (!s) continue;
    assert.ok(s.dir === 1 || s.dir === -1, c.id);
    assert.ok(s.zone[0] <= s.zone[1] && Number.isFinite(s.stop), c.id);
    assert.ok((s.stop - s.zone[0]) * s.dir < 0, `${c.id}: the stop is on the far side`);
  }
  assert.equal(new Set(CANDIDATES.map((c) => c.id)).size, CANDIDATES.length, 'ids are unique');
});
