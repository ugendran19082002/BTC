import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PriceChart } from '@/components/desk/PriceChart';
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
const applied: Record<string, unknown>[] = [];
const primitives: { scene: readonly SceneItem[] }[] = [];

vi.mock('lightweight-charts', () => {
  class Series {
    constructor(public which: string) {}
    setData = vi.fn((data: any[]) => { setDataCalls.push({ which: this.which, data }); });
    priceScale = () => ({ applyOptions: vi.fn() });
    priceToCoordinate = (price: number) => 300 - (price - 77_000) / 10;
    attachPrimitive = vi.fn((p: any) => { primitives.push(p); p.attached?.({ chart: {}, series: this, requestUpdate: () => {} }); });
  }
  return {
    ColorType: { Solid: 'solid' },
    CrosshairMode: { Normal: 0 },
    CandlestickSeries: 'candles',
    HistogramSeries: 'volume',
    createChart: vi.fn(() => ({
      addSeries: vi.fn((kind: string) => new Series(kind)),
      applyOptions: vi.fn((o: Record<string, unknown>) => { applied.push(o); }),
      subscribeCrosshairMove: vi.fn(),
      timeScale: () => ({ setVisibleLogicalRange: vi.fn(), logicalToCoordinate: (i: number) => i * 8 }),
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

  it('[critical] zoom is off until it is asked for, so the page scrolls over the chart', () => {
    chart();
    fireEvent.click(screen.getByRole('button', { name: /^Zoom$/ }));
    expect(applied.some((o) => o.handleScroll === true && o.handleScale === true)).toBe(true);
  });

  it('[critical] is one 5m view, with no timeframe row to switch', () => {
    chart({ tf: '5m' });
    expect(screen.queryByRole('group', { name: 'Timeframe' })).toBeNull();
    expect(screen.queryByRole('button', { name: '15m' })).toBeNull();
    expect(screen.getByLabelText('Setup readout').textContent).toContain('5m');
  });

  it('[critical] draws through a primitive, and never reads the candle still forming', () => {
    chart();
    expect(primitives).toHaveLength(1);
    const scene = primitives[0]!.scene;
    const xs = scene.filter((it) => it.layer !== 'trade')
      .flatMap((it) => (it.t === 'box' || it.t === 'line' ? [it.x1] : it.t === 'mark' || it.t === 'vline' ? [it.x] : it.points.map((p) => p[0])));
    expect(Math.max(-1, ...xs)).toBeLessThan(59);
  });

  it('[critical] says what it is waiting for instead of inventing a trade', () => {
    chart();
    const hud = screen.getByLabelText('Setup readout');
    expect(hud.textContent).toMatch(/NO TRADE|FORMING|READY|ACTIVE/);
    expect(hud.textContent).not.toMatch(/will (reach|hit)/i);
  });

  it('shows the timeframe context when it is given', () => {
    chart({
      context: [
        { tf: '1H', role: 'Regime', trend: 'bull', last: { kind: 'BOS', dir: 'bull', barsAgo: 3 }, setup: null },
        { tf: '5M', role: 'Setup', trend: 'bear', last: null, setup: { dir: 'bear', state: 'READY' } },
      ],
    });
    const ctx = screen.getByLabelText('Timeframe context');
    expect(ctx.textContent).toContain('1H ▲ Regime');
    expect(ctx.textContent).toContain('5M ▼ Setup');
    expect(ctx.textContent).toContain('short ready');
  });

  it('remembers which layers are drawn', () => {
    chart();
    fireEvent.click(screen.getByRole('button', { name: 'Layers' }));
    fireEvent.click(screen.getByLabelText('Structure'));
    const stored = JSON.parse(localStorage.getItem('btc-desk:chart:layers')!) as string[];
    expect(stored).not.toContain('structure');
    expect(stored).toContain('liquidity');
  });

  it('folds the readout to one line', () => {
    chart();
    const hud = screen.getByLabelText('Setup readout');
    fireEvent.click(within(hud).getByRole('button', { expanded: true }));
    expect(within(hud).getByRole('button', { expanded: false })).toBeInTheDocument();
    expect(within(hud).queryByText(/between|waiting|filled/i)).toBeNull();
  });

  it('says it is loading, and what is wrong, instead of drawing an empty chart', () => {
    const { rerender } = render(<PriceChart bars={[]} tf="15m" loading />);
    expect(screen.getByText('Loading candles…')).toBeInTheDocument();
    rerender(<PriceChart bars={[]} tf="15m" error="feed down" />);
    expect(screen.getByRole('alert')).toHaveTextContent('feed down');
  });
});
