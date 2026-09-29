import type { Bar } from '@/lib/smc/types';

/** Monday 21 Sep 2026, 00:00 UTC. */
const T0 = Date.UTC(2026, 8, 21) / 1000;
const M5 = 300;

/** A seeded random walk with trending and ranging stretches: realistic enough to produce every kind of event. */
export function walk(n: number, seed = 7): Bar[] {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out: Bar[] = [];
  let price = 84_000;
  let drift = 0;
  for (let i = 0; i < n; i++) {
    if (i % 60 === 0) drift = (rnd() - 0.5) * 30;
    const open = price;
    const move = drift + (rnd() - 0.5) * 120 + (rnd() < 0.03 ? (rnd() - 0.5) * 600 : 0);
    const close = open + move;
    const high = Math.max(open, close) + rnd() * 60;
    const low = Math.min(open, close) - rnd() * 60;
    out.push({ time: T0 + i * M5, open, high, low, close, volume: 50 + rnd() * 150 + (rnd() < 0.05 ? 400 : 0) });
    price = close;
  }
  return out;
}
