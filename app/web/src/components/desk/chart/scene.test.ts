import { describe, expect, it } from 'vitest';
import { runSmc } from '@/lib/smc/engine';
import { walk } from '@/test/bars';
import { buildScene, DEFAULT_LAYERS, htfScene, LAYERS, type Layer, type SceneItem } from './scene';

const bars = walk(3 * 288, 18);
const st = runSmc(bars, { tfSec: 300 });
const all = new Set<Layer>(LAYERS.map((l) => l.key));
const xsOf = (it: SceneItem) => (it.t === 'mark' || it.t === 'vline' || it.t === 'bubble' ? [it.x] : it.t === 'path' ? it.points.map((p) => p[0]) : it.t === 'profile' ? [] : it.t === 'heat' ? it.cols.map((c) => c.x) : [it.x1, ...(typeof it.x2 === 'number' ? [it.x2] : [])]);

describe('the scene', () => {
  it('[critical] draws nothing past the last closed candle, except the trade box reaching into the space on the right', () => {
    for (const it of buildScene(st, bars, all)) {
      for (const x of xsOf(it)) expect(x).toBeLessThan(it.layer === 'trade' ? bars.length + 40 : bars.length);
    }
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
    expect(labels.some((l) => /^(LONG|SHORT) (plan|entry) /.test(l))).toBe(true);
    // The stop says its points, its R, and why it is there.
    expect(labels.some((l) => /^SL [\d,]+ · −[\d,]+ pts · −1R · (below|above|widened) /.test(l))).toBe(true);
    // Every target says its price, its distance in points and its R.
    for (const l of labels.filter((x) => /^TP[123] /.test(x))) expect(l).toMatch(/^TP[123] [\d,]+ · \+[\d,]+ pts · \+[\d.]+R · /);
    expect(labels.filter((l) => /^TP[123] /.test(l))).toHaveLength(3);
    // One box: the reward and the risk halves share their left and right edges and meet at the entry.
    const boxes = scene.filter((it) => it.t === 'box' && !it.label);
    expect(boxes).toHaveLength(2);
    expect(scene.some((it) => it.t === 'box' && it.label?.startsWith('Entry zone'))).toBe(true);
    const [a, b] = boxes as Extract<SceneItem, { t: 'box' }>[];
    expect([a!.x1, a!.x2]).toEqual([b!.x1, b!.x2]);
    const entry = (scene.find((it) => it.t === 'line' && /^(LONG|SHORT)/.test(it.label ?? '')) as Extract<SceneItem, { t: 'line' }>).y;
    expect([a!.y1, a!.y2, b!.y1, b!.y2].filter((y) => y === entry)).toHaveLength(2);
    // Every trade line spans the box, not the chart.
    for (const it of scene) if (it.t === 'line') expect(it.x2).toBe(a!.x2);
    expect(scene.some((it) => it.t === 'vline')).toBe(true);
    // The trend plan's alignment rides on the entry label when given.
    const noted = buildScene(runSmc(past, { tfSec: 300 }), past, new Set<Layer>(['trade']), [], 'with the 4H trend ✓');
    expect(noted.some((it) => it.t === 'line' && /^(LONG|SHORT) (plan|entry) .* · with the 4H trend ✓$/.test(it.label ?? ''))).toBe(true);
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
