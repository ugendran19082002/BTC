import { describe, expect, it } from 'vitest';
import { DESK_SMC_OPTIONS, MIN_TP1_R, runSmc, SCALE_OUT, SmcEngine, sessionOf } from './engine';
import type { Bar, SmcState } from './types';
import { walk } from '@/test/bars';

const T0 = Date.UTC(2026, 8, 21) / 1000; // a Monday, 00:00 UTC
const M5 = 300;

/** Everything the engine knew at candle k, from a state that may know more. */
function asOf(st: SmcState, k: number) {
  const known = <T extends { known: number }>(xs: readonly T[]) => xs.filter((x) => x.known <= k);
  return {
    swings: known(st.swings),
    breaks: known(st.breaks),
    zones: known(st.zones),
    zoneEvents: known(st.zoneEvents),
    pools: known(st.pools),
    poolEvents: known(st.poolEvents),
    sessions: known(st.sessions),
    tags: known(st.tags),
    vwap: st.vwap.slice(0, k + 1),
    dayOpen: st.dayOpen.slice(0, k + 1),
    setups: st.setups.filter((s) => s.createdAt <= k).map((s) => {
      const events = s.events.filter((e) => e.known <= k);
      const planned = events.some((e) => e.state === 'READY');
      return {
        id: s.id, dir: s.dir, createdAt: s.createdAt, events,
        plan: planned ? { entry: s.entry, stop: s.stop, risk: s.risk, targets: s.targets, poi: s.poi?.id, htf: s.htf } : null,
      };
    }),
  };
}

describe('the no-lookahead contract', () => {
  const bars = walk(3 * 288, 18);
  const full = runSmc(bars, { tfSec: M5 });

  it('produces enough of everything for the test to mean something', () => {
    expect(full.swings.length).toBeGreaterThan(50);
    expect(full.breaks.some((b) => b.kind === 'CHoCH')).toBe(true);
    expect(full.breaks.some((b) => b.kind === 'BOS')).toBe(true);
    expect(full.zones.some((z) => z.kind === 'OB')).toBe(true);
    expect(full.zones.some((z) => z.kind === 'FVG')).toBe(true);
    expect(full.poolEvents.some((e) => e.type === 'swept')).toBe(true);
    expect(full.pools.some((p) => p.kind === 'PDH')).toBe(true);
    expect(full.setups.some((s) => s.events.some((e) => e.state === 'ACTIVE'))).toBe(true);
  });

  it('[critical] the history at every candle is the same whether the engine stopped there or ran on', () => {
    for (let k = 0; k < bars.length; k++) {
      const prefix = runSmc(bars.slice(0, k + 1), { tfSec: M5 });
      expect(asOf(prefix, k), `candle ${k}`).toEqual(asOf(full, k));
    }
  }, 120_000);

  it('[critical] the desk\'s own options keep the contract too', () => {
    const opts = { tfSec: M5, ...DESK_SMC_OPTIONS };
    const whole = runSmc(bars, opts);
    for (let k = 0; k < bars.length; k += 3) {
      expect(asOf(runSmc(bars.slice(0, k + 1), opts), k), `candle ${k}`).toEqual(asOf(whole, k));
    }
  }, 120_000);

  it('[critical] nothing is known before the candle it is drawn on', () => {
    for (const x of [...full.swings, ...full.breaks, ...full.zones, ...full.pools, ...full.tags]) {
      expect(x.known).toBeGreaterThanOrEqual(x.at);
    }
    for (const s of full.swings) expect(s.known - s.at).toBe(2);
  });

  it('[critical] a setup plan is never changed once made', () => {
    const e = new SmcEngine({ tfSec: M5 });
    const plans = new Map<string, string>();
    for (const b of bars) {
      e.push(b);
      for (const s of e.state().setups) {
        if (s.entry === null) continue;
        const plan = JSON.stringify([s.entry, s.stop, s.risk, s.targets]);
        const before = plans.get(s.id);
        if (before) expect(plan).toBe(before);
        else plans.set(s.id, plan);
        if (s.fill) {
          const f = JSON.stringify(s.fill);
          const fb = plans.get(`${s.id}:fill`);
          if (fb) expect(f).toBe(fb); else plans.set(`${s.id}:fill`, f);
        }
      }
    }
    expect(plans.size).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------ hand-built cases

const bar = (i: number, o: number, h: number, l: number, c: number, v = 100): Bar => ({ time: T0 + i * M5, open: o, high: h, low: l, close: c, volume: v });
/** Candles from [open, high, low, close] rows. */
const series = (rows: [number, number, number, number][]) => rows.map(([o, h, l, c], i) => bar(i, o, h, l, c));

describe('structure', () => {
  // up to a high at bar 3 (110), down to a low at bar 6 (95), then a close through 110.
  const rows: [number, number, number, number][] = [
    [100, 102, 99, 101], [101, 104, 100, 103], [103, 106, 102, 105], [105, 110, 104, 106],
    [106, 107, 101, 102], [102, 103, 97, 98], [98, 99, 95, 97], [97, 100, 96, 99], [99, 102, 98, 101],
    [101, 108, 100, 107], [107, 113, 106, 112],
  ];
  const st = runSmc(series(rows), { tfSec: M5 });

  it('a swing is known two candles after it, not on it', () => {
    const high = st.swings.find((s) => s.side === 'high' && s.price === 110)!;
    expect(high).toMatchObject({ at: 3, known: 5 });
    const low = st.swings.find((s) => s.side === 'low' && s.price === 95)!;
    expect(low).toMatchObject({ at: 6, known: 8 });
  });

  it('the first close through the swing high is a BOS, drawn from the swing to the close', () => {
    const b = st.breaks.find((x) => x.dir === 'bull')!;
    expect(b).toMatchObject({ kind: 'BOS', level: 110, from: 3, at: 10, known: 10 });
  });

  it('the break carries its order block: the last down candle before the leg', () => {
    const ob = st.zones.find((z) => z.kind === 'OB' && z.dir === 'bull')!;
    expect(ob).toMatchObject({ at: 6, low: 95, high: 99, known: 10 });
  });

  it('a close through against the trend is a CHoCH', () => {
    const more: [number, number, number, number][] = [
      ...rows,
      [112, 114, 109, 110], [110, 111, 105, 106], [106, 107, 103, 104], [104, 105, 90, 91],
    ];
    const s2 = runSmc(series(more), { tfSec: M5 });
    expect(s2.breaks.some((b) => b.dir === 'bear' && b.kind === 'CHoCH')).toBe(true);
    expect(s2.trend).toBe('bear');
  });
});

describe('liquidity', () => {
  const rows: [number, number, number, number][] = [
    [100, 101, 99, 100], [100, 101, 98, 99], [99, 100, 90, 95], [95, 97, 93, 96], [96, 98, 94, 97],
    // bar 5 wicks under 90 and closes back above: a sweep
    [97, 98, 88, 96],
    // bar 6 closes under 88: taken
    [96, 97, 85, 86],
  ];
  const st = runSmc(series(rows), { tfSec: M5 });

  it('a wick through a swing low that closes back is a sweep of sell-side liquidity', () => {
    const pool = st.pools.find((p) => p.kind === 'SSL' && p.price === 90)!;
    expect(pool.known).toBe(4);
    expect(st.poolEvents.find((e) => e.pool === pool.id)).toMatchObject({ type: 'swept', at: 5 });
  });

  it('a sweep starts a long setup that waits for the structure shift', () => {
    const s = st.setups[0]!;
    expect(s.dir).toBe('bull');
    expect(s.confirmations.map((c) => c.ok)).toEqual([true, false, false, false, false, false]);
  });

  it('closing beyond the sweep invalidates it', () => {
    expect(st.setups[0]!.state).toBe('INVALIDATED');
  });

  it('the previous day high and low appear when the new day starts, not before', () => {
    const day = [bar(0, 100, 105, 95, 101), ...Array.from({ length: 287 }, (_, k) => bar(k + 1, 101, 102, 100, 101)), bar(288, 101, 103, 99, 102)];
    const s = runSmc(day, { tfSec: M5 });
    const pdh = s.pools.find((p) => p.kind === 'PDH')!;
    expect(pdh).toMatchObject({ price: 105, at: 0, known: 288 });
  });
});

describe('gaps', () => {
  it('a three-candle gap is an FVG, and a close through it makes it inverse', () => {
    const rows: [number, number, number, number][] = [
      [100, 102, 99, 101], [101, 110, 101, 109], [109, 112, 105, 111], [111, 112, 106, 107],
      // fills the gap without closing through it, then closes through: an inverse FVG
      [107, 108, 101, 103], [103, 104, 98, 99],
    ];
    const st = runSmc(series(rows), { tfSec: M5 });
    const fvg = st.zones.find((z) => z.kind === 'FVG')!;
    expect(fvg).toMatchObject({ dir: 'bull', low: 102, high: 105, at: 1, known: 2 });
    const evs = st.zoneEvents.filter((e) => e.zone === fvg.id).map((e) => e.type);
    expect(evs).toEqual(['touched', 'filled', 'broken']);
  });
});

describe('sessions', () => {
  it('are named by the candle\'s UTC hour', () => {
    expect(sessionOf(T0)).toBe('Asia');
    expect(sessionOf(T0 + 7 * 3600)).toBe('London');
    expect(sessionOf(T0 + 13 * 3600)).toBe('New York');
    expect(sessionOf(T0 + 21 * 3600)).toBeNull();
  });
});


// ------------------------------------------------------------ setups, as properties over a long walk

describe('setups', () => {
  const bars = walk(3 * 288, 18);
  const st = runSmc(bars, { tfSec: M5 });
  const filled = st.setups.filter((s) => s.fill);
  const bull = (d: string) => d === 'bull';

  it('the fixture fills some trades, long and short, and finishes some', () => {
    expect(filled.length).toBeGreaterThan(2);
    expect(filled.some((s) => s.resultR !== null)).toBe(true);
  });

  it('[critical] no fill without the whole chain: sweep, shift, displacement, zone, retest, close', () => {
    for (const s of filled) {
      expect(s.confirmations.map((c) => c.ok)).toEqual([true, true, true, true, true, true]);
      const at = s.confirmations.map((c) => c.at!);
      for (let k = 1; k < at.length; k++) expect(at[k]!).toBeGreaterThanOrEqual(at[k - 1]!);
      const disp = st.tags.some((t) => t.name === 'Displacement' && t.dir === s.dir && t.at > s.createdAt && t.at <= at[1]!)
        || st.zones.some((z) => z.kind === 'FVG' && z.dir === s.dir && z.known > s.createdAt && z.known <= at[1]!);
      expect(disp, s.id).toBe(true);
    }
  });

  it('[critical] the entry is the close of a candle that closed back out of the zone, in the trade\'s direction', () => {
    for (const s of filled) {
      const b = bars[s.fill!.at]!;
      expect(s.fill!.price).toBe(b.close);
      if (bull(s.dir)) { expect(b.close).toBeGreaterThan(s.poi!.high); expect(b.close).toBeGreaterThan(b.open); }
      else { expect(b.close).toBeLessThan(s.poi!.low); expect(b.close).toBeLessThan(b.open); }
    }
  });

  it('[critical] TP1 pays at least 1.5R, planned and at the fill; targets run outward and each has a reason', () => {
    for (const s of st.setups.filter((x) => x.entry !== null)) {
      expect(s.targets[0]!.rr).toBeGreaterThanOrEqual(MIN_TP1_R);
      const d = s.targets.map((t) => (bull(s.dir) ? t.price - s.entry! : s.entry! - t.price));
      expect(d).toEqual([...d].sort((a, b) => a - b));
      expect(s.targets[0]!.source).not.toBe('R-multiple');
      for (const t of s.targets) expect(t.reason.length).toBeGreaterThan(0);
      if (s.fill) expect((bull(s.dir) ? s.targets[0]!.price - s.fill.price : s.fill.price - s.targets[0]!.price) / s.fill.risk).toBeGreaterThanOrEqual(MIN_TP1_R);
    }
  });

  it('[critical] the stop sits beyond the zone\'s far edge by its buffer, and only ever tightens', () => {
    for (const s of st.setups.filter((x) => x.stop !== null)) {
      if (bull(s.dir)) expect(s.stop!).toBeLessThanOrEqual(s.poi!.low - 1);
      else expect(s.stop!).toBeGreaterThanOrEqual(s.poi!.high + 1);
      let now = s.stop!;
      for (const t of s.trail) {
        if (bull(s.dir)) expect(t.price).toBeGreaterThan(now); else expect(t.price).toBeLessThan(now);
        now = t.price;
      }
    }
  });

  it('[critical] break-even only after TP1 and a new swing in the trade\'s favour', () => {
    for (const s of filled) {
      const tp1 = s.events.find((e) => e.state === 'TP1');
      for (const t of s.trail) {
        expect(tp1, s.id).toBeDefined();
        expect(t.at).toBeGreaterThanOrEqual(tp1!.at);
        const sw = st.swings.find((w) => w.known === t.at && w.side === (bull(s.dir) ? 'low' : 'high'));
        const tp2 = s.events.find((e) => e.state === 'TP2');
        expect(sw !== undefined || tp2?.at === t.at).toBe(true);
      }
    }
  });

  it('[critical] one position at a time: an opposite entry closes the open trade first', () => {
    for (const opts of [{ tfSec: M5 }, { tfSec: M5, ...DESK_SMC_OPTIONS }]) {
      const all = runSmc(bars, opts).setups.filter((x) => x.fill);
      for (const a of all) for (const b of all) {
        if (a === b) continue;
        const aEnd = a.closedAt ?? Infinity;
        // b entered while a was open: only allowed when b is the same side's... never: slots are one a side, so b must be opposite and a closed at b's fill.
        if (b.fill!.at > a.fill!.at && b.fill!.at < aEnd) expect.fail(`${b.id} entered at ${b.fill!.at} while ${a.id} was open until ${aEnd}`);
      }
    }
  });

  it('[critical] the result is 30% at TP1, 30% at TP2, 40% at TP3, the rest at the exit', () => {
    for (const s of filled.filter((x) => x.resultR !== null)) {
      const f = s.fill!;
      const r = (p: number) => (bull(s.dir) ? p - f.price : f.price - p) / f.risk;
      const hits = s.events.filter((e) => e.state === 'TP1' || e.state === 'TP2' || e.state === 'TP3').length;
      const exit = s.events[s.events.length - 1]!.price!;
      const banked = s.targets.slice(0, hits).reduce((a, t, k) => a + SCALE_OUT[k]! * r(t.price), 0);
      const left = 1 - SCALE_OUT.slice(0, hits).reduce((a, b) => a + b, 0);
      expect(s.resultR!).toBeCloseTo(banked + (left > 1e-9 ? left * r(exit) : 0), 9);
      if (s.state === 'STOPPED') expect(s.resultR!).toBeCloseTo(-1, 9);
      if (s.state === 'PROTECTED') expect(s.resultR!).toBeGreaterThanOrEqual(-1e-9);
    }
  });
});
