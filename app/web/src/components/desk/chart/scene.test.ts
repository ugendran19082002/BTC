import { describe, expect, it } from 'vitest';
import { runSmc } from '@/lib/smc/engine';
import { walk } from '@/test/bars';
import { buildScene, DEFAULT_LAYERS, LAYERS, type Layer, type SceneItem } from './scene';

const bars = walk(3 * 288, 11);
const st = runSmc(bars, { tfSec: 300 });
const all = new Set<Layer>(LAYERS.map((l) => l.key));
const xsOf = (it: SceneItem) => (it.t === 'mark' ? [it.x] : it.t === 'path' ? it.points.map((p) => p[0]) : [it.x1, ...(typeof it.x2 === 'number' ? [it.x2] : [])]);

describe('the scene', () => {
  it('[critical] draws nothing past the last closed candle except levels running to the edge', () => {
    for (const it of buildScene(st, bars, all)) for (const x of xsOf(it)) expect(x).toBeLessThan(bars.length);
  });

  it('draws only the layers asked for', () => {
    const only = buildScene(st, bars, new Set<Layer>(['structure']));
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((it) => it.layer === 'structure')).toBe(true);
    expect(buildScene(st, bars, new Set())).toEqual([]);
  });

  it('[critical] keeps the chart readable: at most three resting pools a side, three OBs and three FVGs a direction', () => {
    const scene = buildScene(st, bars, new Set(DEFAULT_LAYERS));
    const pools = scene.filter((it) => it.t === 'line' && it.layer === 'liquidity' && it.x2 === 'right');
    expect(pools.filter((p) => (p as { color: string }).color === '#f59e0b').length).toBeLessThanOrEqual(3);
    expect(pools.filter((p) => (p as { color: string }).color === '#38bdf8').length).toBeLessThanOrEqual(3);
    const live = (label: RegExp) => scene.filter((it) => it.t === 'box' && it.x2 === 'right' && label.test(it.label ?? ''));
    expect(live(/^Bull OB/).length).toBeLessThanOrEqual(3);
    expect(live(/^Bear OB/).length).toBeLessThanOrEqual(3);
    expect(live(/^FVG$/).length).toBeLessThanOrEqual(6);
  });

  it('labels every structure break where it happened, from the swing it broke', () => {
    const breaks = buildScene(st, bars, new Set<Layer>(['structure'])).filter((it) => it.t === 'line');
    expect(breaks.length).toBeGreaterThan(0);
    for (const b of breaks) {
      if (b.t !== 'line') continue;
      expect(b.label).toMatch(/^(BOS|CHoCH|MSS)$/);
      expect(typeof b.x2).toBe('number');
      expect(b.x2 as number).toBeGreaterThan(b.x1);
    }
  });

  it('[critical] a live setup is drawn with its entry, stop and three targets, and their R', () => {
    // Find a candle where a setup was live, and draw the chart as it was then.
    let k = -1;
    for (const s of st.setups) {
      const ready = s.events.find((ev) => ev.state === 'READY');
      if (ready && (s.closedAt ?? Infinity) > ready.at) { k = ready.at; break; }
    }
    expect(k).toBeGreaterThan(0);
    const past = bars.slice(0, k + 1);
    const scene = buildScene(runSmc(past, { tfSec: 300 }), past, new Set<Layer>(['trade']));
    const labels = scene.flatMap((it) => (it.t === 'line' && it.label ? [it.label] : []));
    expect(labels.some((l) => l.startsWith('Entry'))).toBe(true);
    expect(labels.some((l) => /^SL .*−1R$/.test(l))).toBe(true);
    expect(labels.filter((l) => /^TP[123] /.test(l))).toHaveLength(3);
  });
});
