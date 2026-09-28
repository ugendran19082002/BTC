import { describe, expect, it } from 'vitest';
import { runSmc, SmcEngine, sessionOf } from './engine';
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
  const bars = walk(3 * 288);
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
    expect(s.confirmations.map((c) => c.ok)).toEqual([true, false, false, false]);
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

describe('a long setup, start to finish', () => {
  const rows: [number, number, number, number][] = [
    // 0-4: a swing low at 2 (95) and a swing high at 4? no -- a lower high at 1
    [104, 105, 101, 102], [102, 106, 100, 101], [101, 102, 95, 97], [97, 100, 96, 99], [99, 101, 97, 98],
    // 5-7: down to a swing low at 7 (93)
    [98, 99, 94, 95], [95, 97, 94, 96], [96, 97, 93, 95], [95, 98, 94, 97], [97, 99, 95, 96],
    // 10: sweeps 93 and closes back -> FORMING (long)
    [96, 97, 91, 95],
    // 11-12: a swing high at 11 (100) confirmed at 13
    [95, 100, 94, 99], [99, 99.5, 96, 97], [97, 98, 95, 96],
    // 14: a big green candle closes over 100 -> bullish break, OB = last red candle (13: 95-98)
    [96, 104, 95.5, 103.5],
    // 15-16: drift, 17: back into the OB top (98) -> filled
    [103.5, 105, 102, 104], [104, 104.5, 101, 102], [102, 102.5, 97.5, 100],
    // 18+: up through the targets
    [100, 106, 99.5, 105.5], [105.5, 111, 105, 110], [110, 130, 109, 129],
  ];
  const st = runSmc(series(rows), { tfSec: M5 });
  const s = st.setups.find((x) => x.dir === 'bull' && x.events.some((e) => e.state === 'READY'))!;

  it('is planned on the break: entry at the POI top, stop under the sweep, targets at liquidity', () => {
    expect(s).toBeDefined();
    expect(s.entry).toBe(s.poi!.high);
    expect(s.stop!).toBeLessThan(91);
    expect(s.targets).toHaveLength(3);
    expect(s.targets[0]!.price).toBeGreaterThan(s.entry!);
    expect(s.targets.map((t) => t.price)).toEqual([...s.targets.map((t) => t.price)].sort((a, b) => a - b));
  });

  it('fills on the retest and walks through its states in order', () => {
    const states = s.events.map((e) => e.state);
    expect(states[0]).toBe('FORMING');
    expect(states).toContain('READY');
    expect(states.indexOf('ACTIVE')).toBeGreaterThan(states.indexOf('READY'));
    expect(s.confirmations.every((c) => c.ok)).toBe(true);
    expect(s.mfeR!).toBeGreaterThan(0);
  });
});

describe('trade management is conservative', () => {
  it('[critical] the stop is checked before the target inside one candle', () => {
    const e = new SmcEngine({ tfSec: M5 });
    // Reuse the long case up to the fill, then one candle that touches both.
    const rows: [number, number, number, number][] = [
      [104, 105, 101, 102], [102, 106, 100, 101], [101, 102, 95, 97], [97, 100, 96, 99], [99, 101, 97, 98],
      [98, 99, 94, 95], [95, 97, 94, 96], [96, 97, 93, 95], [95, 98, 94, 97], [97, 99, 95, 96],
      [96, 97, 91, 95], [95, 100, 94, 99], [99, 99.5, 96, 97], [97, 98, 95, 96], [96, 104, 95.5, 103.5],
      [103.5, 105, 102, 104], [104, 104.5, 101, 102], [102, 102.5, 97.5, 100],
      [100, 150, 80, 100],
    ];
    for (const b of series(rows)) e.push(b);
    const s = e.state().setups.find((x) => x.events.some((ev) => ev.state === 'ACTIVE'))!;
    expect(s.state).toBe('STOPPED');
    expect(s.resultR).toBe(-1);
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

describe('scaling out', () => {
  it('[critical] a third comes off at each target: TP1 then break-even banks a third of TP1, never zero', () => {
    const bars = walk(3 * 288);
    const st = runSmc(bars, { tfSec: M5 });
    for (const s of st.setups.filter((x) => x.resultR !== null)) {
      const hits = s.targets.filter((_, k) => s.events.some((e) => e.state === `TP${k + 1}`) || (k === 2 && s.state === 'TP3'));
      const banked = hits.reduce((a, t) => a + t.rr / 3, 0);
      if (s.state === 'STOPPED') expect(s.resultR).toBe(-1);
      if (s.state === 'BREAKEVEN') { expect(hits.length).toBeGreaterThan(0); expect(s.resultR).toBeCloseTo(banked, 9); expect(s.resultR!).toBeGreaterThan(0); }
      if (s.state === 'TP3') expect(s.resultR).toBeCloseTo((s.targets[0]!.rr + s.targets[1]!.rr + s.targets[2]!.rr) / 3, 9);
    }
  });

  it('[critical] every target asks at least as much as it risks', () => {
    const st = runSmc(walk(3 * 288), { tfSec: M5 });
    const planned = st.setups.filter((s) => s.entry !== null);
    expect(planned.length).toBeGreaterThan(0);
    for (const s of planned) for (const t of s.targets) expect(t.rr).toBeGreaterThanOrEqual(1);
  });
});
