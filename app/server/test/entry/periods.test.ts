import { test } from 'node:test';
import assert from 'node:assert/strict';
import { METHODS } from '../../src/entry/methods.js';
import { readMethod } from '../../src/entry/engine.js';
import { atr, trendOf } from '../../src/entry/prims.js';
import { PERIOD_BARS, type EntryContext } from '../../src/entry/types.js';
import { ctxOf, path, wave } from './bars.js';

/**
 * The week and month methods' history (#64-#69, 18 Oct 2026 audit): with the frames' 220 bars a week method had the
 * whole previous week only from Monday to Wednesday, a month method the previous month only in its first days -- none
 * of the six formed even a WAIT from 1 to 18 Oct. A longer 1h / 4h history is theirs alone (`ctx.periods`).
 */
const H = 3_600;
const MON = Date.UTC(2026, 9, 12) / 1000;            // Monday 12 Oct 2026, 00:00 UTC: the week running
const NOW = MON + 3 * 86_400 + 12 * H;               // Thursday, midday
const WEEK = (id: string) => METHODS.find((m) => m.id === id)!;

/** 1h candles from two weeks and a day before Monday: last week's high 85,000 on its Tuesday, 84,500 otherwise. */
function hourly() {
  const from = MON - PERIOD_BARS['1h'] * H + 3.5 * 86_400;
  const n = Math.floor((NOW - from) / H);
  const closes = Array.from({ length: n }, (_, i) => {
    const t = from + i * H;
    return t >= MON - 6 * 86_400 && t < MON - 6 * 86_400 + H ? 85_000 : 84_500;
  });
  return path(closes, { step: H, t0: from, w: 5 });
}
/** 15m candles at 84,900, then one through last week's high and one back under it, turning: a sweep rejected. */
function sweep15() {
  const closes = [...Array.from({ length: 70 }, () => 84_900), 85_030, 84_850];
  return path(closes, { step: 900, t0: NOW - closes.length * 900, w: 5 });
}

test('[critical] a week method has the whole previous week on a Thursday with the longer history -- not with the frame\'s 220 bars alone', () => {
  const h1 = hourly(), bars = sweep15();
  const a = atr(bars)!, trend = trendOf(bars);
  const frameOnly: EntryContext = ctxOf({ now: NOW * 1000, frames: { '15m': bars, '1h': h1.slice(-220) } });
  const withLong: EntryContext = { ...frameOnly, periods: { '1h': h1 } };
  assert.equal(WEEK('week-sweep').detect({ bars, a, trend, ctx: frameOnly }), null, 'the 220 bars start inside last week: no level, no setup');
  const s = WEEK('week-sweep').detect({ bars, a, trend, ctx: withLong });
  assert.ok(s, 'last week whole: its high 85,005 swept and rejected');
  assert.equal(s!.dir, -1);
  assert.match(s!.steps.map((x) => x.label).join(' '), /previous week's/);
});

test('[critical] the frame stays the fresher: a candle in both is the frame\'s, and the week running is read up to the minute', () => {
  const h1 = hourly(), bars = sweep15();
  const stale = h1.slice(0, -5);                        // the longer history ten minutes behind, five bars short
  const ctx: EntryContext = ctxOf({ now: NOW * 1000, frames: { '15m': bars, '1h': h1.slice(-220) }, periods: { '1h': stale } });
  assert.ok(WEEK('week-sweep').detect({ bars, a: atr(bars)!, trend: trendOf(bars), ctx }), 'the previous week from the history, now from the frame');
});

test('[critical] parity: every other method reads exactly as it did -- the longer history is the six\'s alone', () => {
  const SIX = new Set(['week-sweep', 'month-sweep', 'week-expansion', 'month-expansion', 'week-reclaim', 'month-reclaim']);
  const t0 = NOW - 300 * 300;
  const m5 = path(wave(300, 84_000, 120, 24, 0.4), { step: 300, t0 });
  const h1 = hourly(), h4 = path(wave(372, 84_000, 600, 30, 1), { step: 4 * H, t0: NOW - 372 * 4 * H });
  const base: EntryContext = ctxOf({ now: NOW * 1000, frames: { '5m': m5, '1h': h1.slice(-220), '4h': h4.slice(-220) } });
  const long: EntryContext = { ...base, periods: { '1h': h1, '4h': h4 } };
  // The regime's week and month ranges are the six's inputs too, and are filled in now: everything else is the same.
  const strip = (r: ReturnType<typeof readMethod>) => JSON.stringify({ ...r, regime: r.regime ? { ...r.regime, weekRange: null, monthRange: null } : r.regime });
  let compared = 0;
  for (const m of METHODS) {
    if (SIX.has(m.id)) continue;
    for (const [mode, tf] of [['single', '5m'], ['mtf', '5m']] as const) {
      assert.equal(strip(readMethod(m, mode, tf, long)), strip(readMethod(m, mode, tf, base)), `${m.id} ${mode}`);
      compared++;
    }
  }
  assert.equal(compared, (METHODS.length - SIX.size) * 2);
});
