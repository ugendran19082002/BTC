import { describe, expect, it } from 'vitest';
import { runSmc } from '@/lib/smc/engine';
import { walk } from '@/test/bars';
import { buildScene, DEFAULT_LAYERS, htfScene, LAYERS, type Layer, type SceneItem } from './scene';

const bars = walk(3 * 288, 18);
const st = runSmc(bars, { tfSec: 300 });
const all = new Set<Layer>(LAYERS.map((l) => l.key));
const xsOf = (it: SceneItem) => (it.t === 'mark' || it.t === 'bubble' ? [it.x] : it.t === 'path' ? it.points.map((p) => p[0]) : it.t === 'profile' ? [] : it.t === 'heat' ? it.cols.map((c) => c.x) : [it.x1, ...(typeof it.x2 === 'number' ? [it.x2] : [])]);

describe('the scene', () => {
  it('[critical] draws nothing past the last closed candle', () => {
    for (const it of buildScene(st, bars, all)) {
      for (const x of xsOf(it)) expect(x).toBeLessThan(bars.length);
    }
  });

  it('[critical] decides no entry: no layer draws a trade, a plan or a trend position (the entry section owns entries)', () => {
    expect(LAYERS.map((l) => l.key)).not.toContain('trade');
    expect(LAYERS.map((l) => l.key)).not.toContain('trend');
    const labels = buildScene(st, bars, all).flatMap((it) => ('label' in it && it.label ? [it.label] : 'text' in it ? [it.text] : []));
    expect(labels.filter((l) => /^(LONG|SHORT)\b|^SL |^TP[123] |^No (long|short)|^Entry zone/.test(l))).toEqual([]);
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
});

describe('higher timeframes on the main chart', () => {
  it('names each object with its timeframe and puts it on the candle it happened on', () => {
    const h15 = walk(96, 3).map((b, i) => ({ ...b, time: bars[0]!.time + i * 900 }));
    const st15 = runSmc(h15, { tfSec: 900 });
    const items = htfScene([{ tf: '15m', tfSec: 900, bars: h15, state: st15, show: 'structure' }], bars);
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(it.layer).toBe('htf');
      if (it.t !== 'line') continue;
      expect(it.label).toMatch(/^15m (BOS|CHoCH|MSS)$/);
      const brk = st15.breaks.find((b) => b.level === it.y)!;
      expect(bars[it.x1]!.time).toBeLessThanOrEqual(h15[brk.from]!.time);
      expect(bars[it.x1 + 1]!.time).toBeGreaterThan(h15[brk.from]!.time);
    }
  });
});
