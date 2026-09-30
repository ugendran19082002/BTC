import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PriceChart, tailFrom } from '@/components/desk/PriceChart';
import type { SceneItem } from '@/components/desk/chart/scene';
import type { Candle } from '@/types/desk';

/*
 * The candles and the concepts are drawn by `lightweight-charts` onto a canvas,
 * which jsdom does not paint. So the library is stubbed and what is asserted
 * is the contract with it: the series get the bars, the scroll lock really
 * locks, and the primitive is handed a scene built from closed candles only.
 * What the scene contains is scene / engine tests' business.
 */

const setDataCalls: { which: string; data: any[] }[] = [];
const updateCalls: { which: string; bar: any }[] = [];
const applied: Record<string, unknown>[] = [];
const primitives: { scene: readonly SceneItem[]; setReserved: (r: unknown[]) => void }[] = [];
const repaints = vi.fn();
const addedTo: { kind: string; pane: number }[] = [];

vi.mock('lightweight-charts', () => {
  class Series {
    constructor(public which: string) {}
    setData = vi.fn((data: any[]) => { setDataCalls.push({ which: this.which, data }); });
    update = vi.fn((bar: any) => { updateCalls.push({ which: this.which, bar }); });
    priceScale = () => ({ applyOptions: vi.fn() });
    priceToCoordinate = (price: number) => 300 - (price - 77_000) / 10;
    attachPrimitive = vi.fn((p: any) => { primitives.push(p); p.attached?.({ chart: {}, series: this, requestUpdate: repaints }); });
    // As the library does: detaching tells the primitive. `chart.remove()` below does not.
    detachPrimitive = vi.fn((p: any) => { p.detached?.(); });
  }
  return {
    ColorType: { Solid: 'solid' },
    CrosshairMode: { Normal: 0 },
    CandlestickSeries: 'candles',
    HistogramSeries: 'volume',
    LineSeries: 'line',
    createChart: vi.fn(() => ({
      addSeries: vi.fn((kind: string, _o?: unknown, pane = 0) => { const s = new Series(kind); addedTo.push({ kind, pane }); return s; }),
      removeSeries: vi.fn(),
      removePane: vi.fn(),
      panes: () => [{ setStretchFactor: vi.fn() }, { setStretchFactor: vi.fn() }],
      applyOptions: vi.fn((o: Record<string, unknown>) => { applied.push(o); }),
      subscribeCrosshairMove: vi.fn(),
      timeScale: () => ({ setVisibleLogicalRange: vi.fn(), logicalToCoordinate: (i: number) => i * 8, subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn() }),
      remove: vi.fn(),
    })),
  };
});

vi.mock('@/api/annotations', () => ({
  getAnnotations: vi.fn(async () => []),
  clearAnnotationsApi: vi.fn(async () => {}),
}));

const HOUR = 3600;
/** Hourly candles ending with one still forming now. */
const bars = (n: number, base = 77_000): Candle[] => {
  const lastOpen = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  return Array.from({ length: n }, (_, i) => ({
    time: lastOpen - (n - 1 - i) * HOUR,
    open: base + i * 10, high: base + i * 10 + 60, low: base + i * 10 - 60,
    close: base + i * 10 + (i % 2 === 0 ? 20 : -20), volume: 100 + i,
  }));
};

const chart = (props: Partial<Parameters<typeof PriceChart>[0]> = {}) =>
  render(<PriceChart bars={bars(60)} tf="1h" {...props} />);

beforeEach(() => {
  setDataCalls.length = 0;
  applied.length = 0;
  primitives.length = 0;
  try { localStorage.clear(); } catch { /* no storage */ }
});

describe('the price chart', () => {
  it('[critical] hands the library the bars, and the volume coloured by the bar', () => {
    chart();
    const candles = setDataCalls.find((c) => c.which === 'candles')!;
    const volume = setDataCalls.find((c) => c.which === 'volume')!;
    expect(candles.data).toHaveLength(60);
    expect(candles.data[0]).toMatchObject({ open: 77_000, high: 77_060, low: 76_940 });
    expect(volume.data[0].color).toContain('38,161,123');
    expect(volume.data[1].color).toContain('226,80,79');
  });

  it('[critical] a tick of the forming candle is one update, not the whole history again', () => {
    const b = bars(60);
    const { rerender } = render(<PriceChart bars={b} tf="1h" />);
    const loads = setDataCalls.filter((c) => c.which === 'candles').length;
    updateCalls.length = 0;
    const ticked = [...b.slice(0, -1), { ...b[59]!, close: b[59]!.close + 5, high: b[59]!.high + 5 }];
    rerender(<PriceChart bars={ticked} tf="1h" />);
    expect(setDataCalls.filter((c) => c.which === 'candles')).toHaveLength(loads);
    expect(updateCalls.filter((c) => c.which === 'candles').map((c) => c.bar.close)).toEqual([b[59]!.close + 5]);
    // Fresh history from the poll (new objects) is a full load again.
    rerender(<PriceChart bars={bars(60)} tf="1h" />);
    expect(setDataCalls.filter((c) => c.which === 'candles')).toHaveLength(loads + 1);
  });

  it('tailFrom: the tail alone changed, or a full load', () => {
    const b = bars(5);
    expect(tailFrom([], b)).toBe(-1);
    expect(tailFrom(b, [...b.slice(0, -1), { ...b[4]! }])).toBe(4);
    expect(tailFrom(b, [...b, { ...b[4]!, time: b[4]!.time + HOUR }])).toBe(4);
    expect(tailFrom(b, [...b.slice(0, 3), { ...b[3]! }, b[4]!])).toBe(-1);
    expect(tailFrom(b, b.slice(0, 4))).toBe(-1);
    expect(tailFrom(b, [...b, { ...b[4]! }])).toBe(-1);
  });

  it('[critical] a preset sets the layers in one click; the default is the lean Desk set', () => {
    chart();
    fireEvent.click(screen.getByRole('button', { name: /Layers/ }));
    const presets = screen.getByRole('group', { name: 'Layer presets' });
    expect(within(presets).getByRole('button', { name: 'Desk' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText(/^Liquidity heatmap \(book\)/) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(presets).getByRole('button', { name: 'Order flow' }));
    expect((screen.getByLabelText(/^Liquidity heatmap \(book\)/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/^Structure/) as HTMLInputElement).checked).toBe(false);
    expect(within(presets).getByRole('button', { name: 'Order flow' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('[critical] None unchecks every layer in one click, and the choice is remembered', () => {
    chart();
    fireEvent.click(screen.getByRole('button', { name: /Layers/ }));
    const presets = screen.getByRole('group', { name: 'Layer presets' });
    fireEvent.click(within(presets).getByRole('button', { name: 'None' }));
    expect(within(presets).getByRole('button', { name: 'None' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByRole('checkbox').every((c) => !(c as HTMLInputElement).checked)).toBe(true);
    expect(primitives[primitives.length - 1]!.scene).toEqual([]);
    expect(JSON.parse(localStorage.getItem('btc-desk:chart:layers:v5')!)).toEqual([]);
  });

  it('[critical] the readout carries the perp\'s positioning and the volatility regime', () => {
    chart({ derivs: { oi: { oiContracts: 803_206, change: 14_200, changePct: 1.8, priceChangePct: 0.4, overMinutes: 60, read: 'new longs' }, funding: 0.01 } });
    const line = screen.getByLabelText('Positioning and volatility').textContent ?? '';
    expect(line).toContain('OI 803 BTC ▲1.8% 1h · new longs');
    expect(line).toContain('Funding +0.0100%');
    expect(line).toMatch(/Vol (expanding|normal|quiet) \d\.\d× · ATR \d+ pts/);
  });

  it('[critical] zoom is off until it is asked for, so the page scrolls over the chart', () => {
    chart();
    fireEvent.click(screen.getByRole('button', { name: /^Zoom$/ }));
    expect(applied.some((o) => o.handleScroll === true && o.handleScale === true)).toBe(true);
  });

  it('[critical] is one 5m view, with no timeframe row to switch', () => {
    chart({ tf: '5m' });
    expect(screen.queryByRole('group', { name: 'Timeframe' })).toBeNull();
    expect(screen.queryByRole('button', { name: '15m' })).toBeNull();
    expect(screen.getByLabelText('Chart readout').textContent).toContain('5m');
  });

  it('[critical] offers only the views it is given -- 5m and 1m -- and says which is shown', () => {
    const onView = vi.fn();
    chart({ tf: '5m', views: ['5m', '1m'], onView });
    const views = screen.getByRole('radiogroup', { name: 'Chart timeframe' });
    expect(within(views).getAllByRole('radio').map((b) => b.textContent)).toEqual(['5m', '1m']);
    expect(within(views).getByRole('radio', { name: '5m' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(views).getByRole('radio', { name: '1m' }));
    expect(onView).toHaveBeenCalledWith('1m');
  });

  it('[critical] draws delta and CVD in their own pane under the price, only when there is flow', () => {
    addedTo.length = 0;
    chart({ tf: '5m' });
    expect(addedTo.filter((a) => a.pane === 1)).toEqual([]);
    const b = bars(60);
    chart({ tf: '5m', flowBars: b.slice(-3).map((x) => ({ time: x.time, buy: 10, sell: 4, trades: 9, minutes: 5 })) });
    expect(addedTo.filter((a) => a.pane === 1).map((a) => a.kind)).toEqual(['volume', 'line']);
  });

  it('[critical] never asks a removed chart to repaint (the "Object is disposed" crash)', () => {
    const { unmount } = chart();
    const primitive = primitives[primitives.length - 1]!;
    unmount();
    repaints.mockClear();
    // A resize observed after the chart is gone, before the effect that measures it is cleaned up.
    primitive.setReserved([{ x: 0, y: 0, w: 10, h: 10 }]);
    expect(repaints).not.toHaveBeenCalled();
  });

  it('[critical] draws through a primitive, and never reads the candle still forming', () => {
    chart();
    expect(primitives).toHaveLength(1);
    const scene = primitives[0]!.scene;
    const xs = scene
      .flatMap((it) => (it.t === 'box' || it.t === 'line' ? [it.x1] : it.t === 'mark' || it.t === 'bubble' ? [it.x] : it.t === 'path' ? it.points.map((p) => p[0]) : it.t === 'heat' ? it.cols.map((c) => c.x) : []));
    expect(Math.max(-1, ...xs)).toBeLessThan(59);
  });

  it('shows the timeframe context when it is given', () => {
    chart({
      context: [
        { tf: '1H', role: 'Regime', trend: 'bull', last: { kind: 'BOS', dir: 'bull', barsAgo: 3 } },
        { tf: '5M', role: 'Setup', trend: 'bear', last: null },
      ],
    });
    const ctx = screen.getByLabelText('Timeframe context');
    expect(ctx.textContent).toContain('1H ▲ Regime');
    expect(ctx.textContent).toContain('5M ▼ Setup');
    // Trend only: the chart reads no setup.
    expect(ctx.textContent).not.toMatch(/forming|ready|active/i);
  });

  it('remembers which layers are drawn', () => {
    chart();
    fireEvent.click(screen.getByRole('button', { name: 'Layers' }));
    fireEvent.click(screen.getByLabelText(/^Structure/));
    const stored = JSON.parse(localStorage.getItem('btc-desk:chart:layers:v5')!) as string[];
    expect(stored).not.toContain('structure');
    expect(stored).toContain('liquidity');
  });

  it('folds the readout to one line', () => {
    chart();
    const hud = screen.getByLabelText('Chart readout');
    expect(within(hud).getByText('Last')).toBeInTheDocument();
    fireEvent.click(within(hud).getByRole('button', { expanded: true }));
    expect(within(hud).getByRole('button', { expanded: false })).toBeInTheDocument();
    expect(within(hud).queryByText('Last')).toBeNull();
  });

  it('[critical] decides no entry of its own: no plan, no trades, no trend plan -- only the market', () => {
    chart();
    const hud = screen.getByLabelText('Chart readout');
    expect(hud.textContent).not.toMatch(/NO TRADE|FORMING|READY|ACTIVE|Plan|Trades|Measured/);
    expect(screen.queryByLabelText('Trade plan')).toBeNull();
    expect(screen.queryByLabelText('Trend plan')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Layers' }));
    expect(screen.queryByLabelText(/^Trade/)).toBeNull();
    expect(screen.queryByLabelText(/^Trend plan/)).toBeNull();
    expect(primitives[0]!.scene.some((it) => it.layer === 'entry')).toBe(false);
  });

  it('[critical] draws the entry section\'s setup it is given: the entry zone, the stop and the targets, to the right edge', () => {
    const b = bars(60);
    chart({
      bars: b,
      entry: { dir: 'long', entryLo: 77_500, entryHi: 77_560, stop: 77_300, tp1: 78_100, tp2: 78_400, tp3: null, rr: 2.1, label: '#1 Breakout (with TF)', triggerTime: b[50]!.time },
    });
    const drawn = primitives[0]!.scene.filter((it) => it.layer === 'entry');
    const labels = drawn.map((it) => ('label' in it ? it.label : ''));
    expect(labels[0]).toMatch(/^LONG #1 Breakout \(with TF\) · entry 77,500–77,560$/);
    // Measured from the fill, the top of the zone (77,560): risk 260.
    expect(labels).toContain('ENTRY 77,560');
    expect(labels).toContain('SL 77,300 · −1.0R · 260 pts');
    expect(labels).toContain('TP1 78,100 · +2.1R · 540 pts · R:R 2.1 after fees');
    expect(labels).toContain('TP2 78,400 · +3.2R · 840 pts');
    for (const it of drawn) if (it.t === 'box' || it.t === 'line') { expect(it.x1).toBe(50); expect(it.x2).toBe('right'); }
  });

  it('[critical] a compact chart (the twelve-chart grid) is candles and levels only: no readout, no toolbar', () => {
    chart({ size: 'compact', label: 'Breakout price chart' });
    expect(screen.getByLabelText('Breakout price chart').className).toContain('pc-compact');
    expect(screen.queryByLabelText('Chart readout')).toBeNull();
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('says it is loading, and what is wrong, instead of drawing an empty chart', () => {
    const { rerender } = render(<PriceChart bars={[]} tf="15m" loading />);
    expect(screen.getByText('Loading candles…')).toBeInTheDocument();
    rerender(<PriceChart bars={[]} tf="15m" error="feed down" />);
    expect(screen.getByRole('alert')).toHaveTextContent('feed down');
  });
});
