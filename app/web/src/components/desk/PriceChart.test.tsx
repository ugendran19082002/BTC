import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PriceChart, CHART_TFS } from '@/components/desk/PriceChart';
import type { Candle } from '@/types/desk';

/*
 * The candles are drawn by `lightweight-charts` onto a canvas, which jsdom
 * does not paint and a test cannot read. So the library is stubbed and what is
 * asserted is the contract with it: that the series are given the bars and the
 * volume in the right shape and colours, that the lock really does turn its
 * scrolling off, and that the desk's own overlay is drawn over it. Where the
 * overlay's shapes end up is `chart-overlay.test.ts`.
 */

const series = { candles: null as any, volume: null as any };
const setDataCalls: { which: string; data: any[] }[] = [];
const applied: Record<string, unknown>[] = [];
const priceLines: any[] = [];

vi.mock('lightweight-charts', () => {
  class Series {
    constructor(public which: string) {}
    setData = vi.fn((data: any[]) => { setDataCalls.push({ which: this.which, data }); });
    priceScale = () => ({ applyOptions: vi.fn() });
    priceToCoordinate = (price: number) => 300 - (price - 77_000) / 10;
    createPriceLine = vi.fn((o: unknown) => { priceLines.push(o); return o; });
    removePriceLine = vi.fn();
  }
  return {
    ColorType: { Solid: 'solid' },
    CrosshairMode: { Normal: 0 },
    LineStyle: { Dashed: 2 },
    CandlestickSeries: 'candles',
    HistogramSeries: 'volume',
    createChart: vi.fn(() => ({
      addSeries: vi.fn((kind: string) => {
        const s = new Series(kind);
        if (kind === 'candles') series.candles = s; else series.volume = s;
        return s;
      }),
      applyOptions: vi.fn((o: Record<string, unknown>) => { applied.push(o); }),
      subscribeCrosshairMove: vi.fn(),
      timeScale: () => ({
        subscribeVisibleTimeRangeChange: vi.fn(),
        setVisibleLogicalRange: vi.fn(),
        fitContent: vi.fn(),
        timeToCoordinate: (t: number) => (t % 1000) / 2,
      }),
      remove: vi.fn(),
    })),
  };
});

const bars = (n: number, base = 77_000): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    time: 1_757_000_000 + i * 3600,
    open: base + i * 10, high: base + i * 10 + 60, low: base + i * 10 - 60,
    close: base + i * 10 + (i % 2 === 0 ? 20 : -20), volume: 100 + i,
  }));

const noop = () => {};
const chart = (props: Partial<Parameters<typeof PriceChart>[0]> = {}) =>
  render(
    <PriceChart bars={bars(40)} support={74_400} resistance={80_000} spot={77_200}
      tf="15m" onTf={noop} {...props} />,
  );

beforeEach(() => {
  setDataCalls.length = 0;
  applied.length = 0;
  priceLines.length = 0;
  try { localStorage.clear(); } catch { /* no storage */ }
});

describe('the price chart', () => {
  it('[critical] hands the library the bars, and the volume coloured by the bar', () => {
    chart();
    const candles = setDataCalls.find((c) => c.which === 'candles')!;
    const volume = setDataCalls.find((c) => c.which === 'volume')!;
    expect(candles.data).toHaveLength(40);
    expect(candles.data[0]).toMatchObject({ open: 77_000, high: 77_060, low: 76_940 });
    expect(volume.data[0].value).toBe(100);
    // an up bar is green, a down bar red: the histogram is read alongside the candles
    expect(volume.data[0].color).toContain('38,161,123');
    expect(volume.data[1].color).toContain('226,80,79');
  });

  it('[critical] draws spot, and names the open-interest walls under the chart instead', () => {
    /*
     * The walls were two more horizontals through the candles, competing with
     * the bands the state is actually judged against -- for levels that are
     * not levels in the price sense at all. They are where open interest sits.
     */
    chart();
    expect(priceLines.map((l) => l.title)).toEqual(['Spot']);
    expect(priceLines[0].price).toBe(77_200);
    const note = screen.getByText(/where open interest sits/);
    expect(note.textContent).toContain('74,400');
    expect(note.textContent).toContain('80,000');
  });

  it('says so rather than showing a price when the board has no wall', () => {
    chart({ support: null, resistance: null });
    expect(screen.getByText(/where open interest sits/).textContent).toContain('—');
  });

  it('[critical] zoom is off until it is asked for, so the page scrolls over the chart', () => {
    /*
     * The chart sits in the middle of a long page. A wheel that always zooms is
     * a wheel that stops the page dead wherever the pointer is resting.
     */
    chart();
    expect(screen.getByRole('button', { name: 'Zoom off' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText(/zoom is off, so the page scrolls over the chart/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Zoom off' }));
    expect(applied.at(-1)).toMatchObject({ handleScroll: true, handleScale: true });
    expect(screen.getByRole('button', { name: 'Zoom on' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers one timeframe row, and only the five the desk reads', () => {
    // Two timeframe controls for one question is two answers the moment they
    // disagree: the chart owns the row and the analysis follows it.
    const seen: string[] = [];
    chart({ onTf: (t) => seen.push(t) });
    for (const t of CHART_TFS) expect(screen.getByRole('radio', { name: t })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: '1m' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: '1h' }));
    expect(seen).toEqual(['1h']);
  });

  it('shows the newest bar in the header until the crosshair says otherwise', () => {
    chart();
    expect(screen.getByText('last')).toBeInTheDocument();
    expect(screen.getByText('40 bars')).toBeInTheDocument();
    // the last bar of the fixture: open 77,390, close 77,370
    expect(screen.getByText('77,390')).toBeInTheDocument();
  });

  it('says what is wrong instead of drawing an empty chart', () => {
    const { rerender } = chart({ bars: [], loading: true });
    expect(screen.getByText('Loading candles…')).toBeInTheDocument();
    rerender(<PriceChart bars={[]} support={null} resistance={null} spot={77_200} tf="15m" onTf={noop} error="feed down" />);
    expect(screen.getByText('feed down')).toBeInTheDocument();
  });
});
