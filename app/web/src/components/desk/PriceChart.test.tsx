import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PriceChart } from '@/components/desk/PriceChart';
import type { Candle } from '@/types/desk';

/**
 * The chart is here to put the two open-interest walls against recent price, so
 * the one thing that must not happen is a wall drawn outside the picture: a
 * resistance line clipped off the top reads as "price is nowhere near it" when
 * the truth may be the opposite.
 */

const bars = (n: number, base = 77_000): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    time: 1_757_000_000 + i * 3600,
    open: base + i * 10,
    high: base + i * 10 + 60,
    low: base + i * 10 - 60,
    close: base + i * 10 + 20,
    volume: 100,
  }));

const noop = () => {};

describe('the price chart', () => {
  it('draws a body, a wick and a volume bar for every bar', () => {
    const { container } = render(
      <PriceChart bars={bars(12)} support={74_400} resistance={80_000} spot={77_172} tf="1h" onTf={noop} />,
    );
    // 12 candle bodies + 12 volume bars + three level tags
    expect(container.querySelectorAll('rect')).toHaveLength(12 + 12 + 3);
    expect(container.querySelectorAll('line').length).toBeGreaterThanOrEqual(12);
  });

  it('[critical] nothing is drawn outside the canvas, wherever the walls sit', () => {
    // price sits around 77,000; the walls are thousands away on either side
    const { container } = render(
      <PriceChart bars={bars(10)} support={60_000} resistance={95_000} spot={77_172} tf="1h" onTf={noop} />,
    );
    const svg = container.querySelector('svg')!;
    const [, , , heightAttr] = svg.getAttribute('viewBox')!.split(' ').map(Number);
    const ys = [...svg.querySelectorAll('line')].flatMap((l) =>
      [l.getAttribute('y1'), l.getAttribute('y2')].map(Number),
    );
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(heightAttr!);
  });

  it('[critical] a wall far outside the range is pinned and said to be off the scale', () => {
    // The first version stretched the axis to reach the walls, which flattened
    // every candle into a few pixels. Now the scale is price's and the wall
    // says how far away it is instead.
    render(
      <PriceChart bars={bars(10)} support={60_000} resistance={95_000} spot={77_172} tf="1h" onTf={noop} />,
    );
    expect(screen.getByText(/95,000 · .*% away, off the scale/)).toBeInTheDocument();
    expect(screen.getByText(/60,000 · .*% away, off the scale/)).toBeInTheDocument();
  });

  it('[critical] a pinned wall clears the volume baseline and the axis labels', () => {
    // At 7px of inset the bottom pin, the volume baseline and the lowest price
    // label all landed within a few pixels of each other and drew over one
    // another. Nothing in the right-hand gutter may overlap a level tag.
    const { container } = render(
      <PriceChart bars={bars(20)} support={60_000} resistance={95_000} spot={77_172} tf="1h" onTf={noop} />,
    );
    const svg = container.querySelector('svg')!;
    const tags = [...svg.querySelectorAll('rect[rx="3"]')].map((r) => Number(r.getAttribute('y')));
    // the axis price labels only: a tag's own text sits in the same gutter and
    // is centred, which is how it is told apart from a label
    const labels = [...svg.querySelectorAll('text')]
      .filter((t) => Number(t.getAttribute('x')) > 700
        && t.getAttribute('text-anchor') !== 'middle'
        && Number(t.getAttribute('opacity') ?? 1) > 0)
      .map((t) => Number(t.getAttribute('y')));

    for (const tagY of tags) {
      for (const labelY of labels) {
        expect(Math.abs(labelY - (tagY + 8))).toBeGreaterThanOrEqual(11);
      }
    }
  });

  it('a wall inside the range is drawn on the axis, with no caveat', () => {
    render(
      <PriceChart bars={bars(10, 77_000)} support={76_960} resistance={77_120} spot={77_040} tf="1h" onTf={noop} />,
    );
    expect(screen.queryByText(/off the scale/)).not.toBeInTheDocument();
  });

  it('reads out the last bar before anything is hovered', () => {
    render(
      <PriceChart bars={bars(10)} support={74_400} resistance={80_000} spot={77_172} tf="1h" onTf={noop} />,
    );
    expect(screen.getByText('last')).toBeInTheDocument();
    expect(screen.getByText('O')).toBeInTheDocument();
    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('offers every timeframe the desk fetches', () => {
    render(
      <PriceChart bars={bars(8)} support={null} resistance={null} spot={77_172} tf="1h" onTf={noop} />,
    );
    for (const t of ['5m', '15m', '1h', '4h', '1D']) {
      expect(screen.getByRole('radio', { name: t })).toBeInTheDocument();
    }
  });

  it('labels both walls and the price, however far away they sit', () => {
    render(
      <PriceChart bars={bars(8)} support={74_400} resistance={80_000} spot={77_172} tf="1h" onTf={noop} />,
    );
    // far out, so each carries an arrow saying which edge it was pinned to
    expect(screen.getAllByText(/74,400/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/80,000/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('77,172').length).toBeGreaterThan(0);
  });

  it('draws price alone when the board has no open interest to read', () => {
    const { container } = render(
      <PriceChart bars={bars(8)} support={null} resistance={null} spot={77_172} tf="1h" onTf={noop} />,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(screen.queryByText(/walls at/)).not.toBeInTheDocument();
  });

  it('changes timeframe', () => {
    const onTf = vi.fn();
    render(
      <PriceChart bars={bars(8)} support={74_400} resistance={80_000} spot={77_172} tf="1h" onTf={onTf} />,
    );
    screen.getByRole('radio', { name: '15m' }).click();
    expect(onTf).toHaveBeenCalledWith('15m');
  });

  it('says the feed is down rather than drawing an empty box', () => {
    const { container } = render(
      <PriceChart
        bars={[]} support={74_400} resistance={80_000} spot={77_172} tf="1h" onTf={noop}
        error="delta request failed"
      />,
    );
    expect(screen.getByText(/price feed did not answer/)).toBeInTheDocument();
    expect(screen.getByText(/Everything below still reads/)).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeInTheDocument();
  });

  it('says it is loading rather than showing nothing', () => {
    render(
      <PriceChart bars={[]} support={null} resistance={null} spot={77_172} tf="1h" onTf={noop} loading />,
    );
    expect(screen.getByText('Loading bars…')).toBeInTheDocument();
  });

  it('says what the lines are, and what they are not', () => {
    render(
      <PriceChart bars={bars(8)} support={74_400} resistance={80_000} spot={77_172} tf="1h" onTf={noop} />,
    );
    expect(screen.getByText(/heaviest put strike/)).toBeInTheDocument();
    expect(screen.getByText(/not where BTC will settle/)).toBeInTheDocument();
  });
});
