import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PriceChart, pinchZoom, stretchByDrag, zoomByButton, zoomHorizontally, zoomVertically } from '@/components/desk/PriceChart';
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

// Whether zoom is armed is remembered, so one test's click would otherwise be
// the next test's starting state.
beforeEach(() => { try { localStorage.clear(); } catch { /* no storage */ } });

/**
 * A rendered chart with the wheel armed and a real bounding box.
 *
 * jsdom gives every element a zero-width box, and the chart refuses to resolve
 * a pointer position inside one — so without this the gesture cannot be driven
 * through the DOM at all and only the arithmetic can be tested.
 */
const armedChart = (props: Partial<Parameters<typeof PriceChart>[0]> = {}) => {
  const r = render(
    <PriceChart
      bars={bars(200)} support={74_400} resistance={80_000} spot={77_172}
      tf="5m" onTf={noop} {...props}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Zoom off/ }));
  const svg = r.container.querySelector('.price-chart-svg')!;
  svg.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 780, bottom: 360, width: 780, height: 360, x: 0, y: 0,
    toJSON: () => ({}),
  }) as DOMRect;
  return { ...r, svg };
};

describe('the price chart', () => {
  it('draws a body, a wick and a volume bar for every bar', () => {
    const { container } = render(
      <PriceChart bars={bars(12)} support={74_400} resistance={80_000} spot={77_172} tf="1h" onTf={noop} />,
    );
    // Counted by what they are, not by how many rects the drawing happens to
    // hold: a level tag or an axis grip should not break a test about candles.
    const svg = container.querySelector('.price-chart-svg')!;
    expect(svg.querySelectorAll('.candle-body')).toHaveLength(12);
    expect(svg.querySelectorAll('.vol-bar')).toHaveLength(12);
    expect(svg.querySelectorAll('line').length).toBeGreaterThanOrEqual(12);
  });

  it('[critical] nothing is drawn outside the canvas, wherever the walls sit', () => {
    // price sits around 77,000; the walls are thousands away on either side
    const { container } = render(
      <PriceChart bars={bars(10)} support={60_000} resistance={95_000} spot={77_172} tf="1h" onTf={noop} />,
    );
    const svg = container.querySelector('.price-chart-svg')!;
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
    expect(container.querySelector('.price-chart-svg')).toBeInTheDocument();
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
    // the chart itself, not the fold chevron, which is an svg of its own
    expect(container.querySelector('.price-chart-svg')).not.toBeInTheDocument();
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

/**
 * Zoom and pan.
 *
 * The chart carries a day of 5-minute bars, and a chart you cannot pull into is
 * a chart that hides the hour that mattered. What must not happen is a zoom
 * that quietly drops bars off the count it reports, or a pan that walks past
 * the ends of the series.
 */
describe('zoom and pan', () => {
  const many = bars(200);

  const chart = (props: Partial<Parameters<typeof PriceChart>[0]> = {}) =>
    render(
      <PriceChart
        bars={many} support={74_400} resistance={80_000} spot={77_172}
        tf="5m" onTf={noop} {...props}
      />,
    );

  it('opens fitted to the whole series, with nothing to fit and nothing further out', () => {
    chart();
    expect(screen.getByText('200 of 200 bars')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fit/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'zoom out' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'zoom in' })).toBeEnabled();
  });

  /*
   * The arithmetic, not the gesture.
   *
   * jsdom gives every element a zero-width bounding box, so a wheel dispatched
   * at a test never resolves to a position on the plot and the interaction
   * cannot be driven through the DOM at all. The maths is the part that can be
   * wrong, so it is the part that is pinned.
   */
  const fitted = { from: 0, count: 200, yZoom: 1 };

  it('[critical] zooming in shows fewer bars, about the pointer', () => {
    const inAtMiddle = zoomHorizontally(fitted, 200, { anchor: 0.5, out: false });
    expect(inAtMiddle.count).toBeLessThan(200);
    // what was under the middle is still under the middle
    const before = fitted.from + 0.5 * fitted.count;
    const after = inAtMiddle.from + 0.5 * inAtMiddle.count;
    expect(Math.abs(before - after)).toBeLessThanOrEqual(1);
  });

  it('[critical] never zooms out past the whole series', () => {
    let v = fitted;
    for (let i = 0; i < 30; i++) v = zoomHorizontally(v, 200, { anchor: 0.5, out: true });
    expect(v.count).toBe(200);
    expect(v.from).toBe(0);
  });

  it('[critical] never zooms in past a readable number of bars', () => {
    let v = fitted;
    for (let i = 0; i < 80; i++) v = zoomHorizontally(v, 200, { anchor: 0.5, out: false });
    expect(v.count).toBeGreaterThanOrEqual(12);
  });

  it('never walks the window past either end', () => {
    const atLeft = zoomHorizontally(fitted, 200, { anchor: 0, out: false });
    expect(atLeft.from).toBeGreaterThanOrEqual(0);
    const atRight = zoomHorizontally(fitted, 200, { anchor: 1, out: false });
    expect(atRight.from + atRight.count).toBeLessThanOrEqual(200);
  });

  it('a series shorter than the floor is still shown whole', () => {
    const tiny = zoomHorizontally({ from: 0, count: 5, yZoom: 1 }, 5, { anchor: 0.5, out: false });
    expect(tiny.count).toBe(5);
  });

  it('the price scale stretches and contracts, within bounds', () => {
    let v = fitted;
    for (let i = 0; i < 40; i++) v = zoomVertically(v, false);
    expect(v.yZoom).toBeLessThanOrEqual(8);
    for (let i = 0; i < 80; i++) v = zoomVertically(v, true);
    expect(v.yZoom).toBeGreaterThanOrEqual(0.4);
  });

  it('stretching the price scale leaves the window alone', () => {
    const v = zoomVertically({ from: 40, count: 60, yZoom: 1 }, false);
    expect(v.from).toBe(40);
    expect(v.count).toBe(60);
  });

  it('offers every timeframe, 1m through 1D', () => {
    chart();
    for (const t of ['1m', '5m', '15m', '1h', '4h', '1D']) {
      expect(screen.getByRole('radio', { name: t })).toBeInTheDocument();
    }
  });

  it('says how to work it, rather than leaving it to be discovered', () => {
    armedChart();
    expect(screen.getByText(/scroll or pinch to zoom · drag to pan/)).toBeInTheDocument();
  });

  it('the price scale may be pulled out far enough to reach the walls', () => {
    // The floor was a flat 0.4, which widens a quiet hour's range by two and a
    // half times — nowhere near a wall six thousand dollars away.
    let v = fitted;
    for (let i = 0; i < 80; i++) v = zoomVertically(v, true, 0.05);
    expect(v.yZoom).toBeCloseTo(0.05, 4);
  });

  it('a floor above the old limit never tightens it', () => {
    let v = fitted;
    for (let i = 0; i < 80; i++) v = zoomVertically(v, true, 0.9);
    expect(v.yZoom).toBeCloseTo(0.4, 4);
  });
});

/**
 * Zoom is a mode, and the chart says which one it is in.
 *
 * The chart sits in the middle of a long scrolling page. A wheel that always
 * zooms is a wheel that stops the page dead wherever the pointer happens to
 * rest, and on a phone the plot swallowed a scroll entirely.
 */
describe('arming zoom', () => {
  it('[critical] leaves the wheel to the page until it is armed', () => {
    const { container } = render(
      <PriceChart
        bars={bars(200)} support={74_400} resistance={80_000} spot={77_172}
        tf="5m" onTf={noop}
      />,
    );
    const svg = container.querySelector('.price-chart-svg')!;
    svg.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 780, bottom: 360, width: 780, height: 360, x: 0, y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

    expect(screen.getByRole('button', { name: /Zoom off/ })).toHaveAttribute('aria-pressed', 'false');
    expect(svg).not.toHaveClass('armed');

    // not cancelled: the page keeps the gesture
    expect(fireEvent.wheel(svg, { deltaY: -100, clientX: 390 })).toBe(true);
    expect(screen.getByText('200 of 200 bars')).toBeInTheDocument();
  });

  it('[critical] takes the wheel, and zooms, once it is armed', () => {
    const { svg } = armedChart();
    expect(svg).toHaveClass('armed');
    // cancelled: the chart owns the gesture and the page does not move
    expect(fireEvent.wheel(svg, { deltaY: -100, clientX: 390 })).toBe(false);
    expect(screen.queryByText('200 of 200 bars')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fit/ })).toBeInTheDocument();
  });

  it('[critical] turning zoom off keeps the view where it was', () => {
    // The reason to turn it off is to stop the wheel moving the chart -- not
    // to have the chart moved. The range that was pulled into stays.
    const { svg } = armedChart();
    fireEvent.wheel(svg, { deltaY: -100, clientX: 390 });
    fireEvent.wheel(svg, { deltaY: -100, clientX: 390 });
    const shown = screen.getByText(/of 200 bars/).textContent;
    expect(shown).not.toBe('200 of 200 bars');

    fireEvent.click(screen.getByRole('button', { name: /Zoom on/ }));
    expect(screen.getByText(/of 200 bars/).textContent).toBe(shown);
    // the wheel is the page's again, and the view still does not move
    expect(fireEvent.wheel(svg, { deltaY: -100, clientX: 390 })).toBe(true);
    expect(screen.getByText(/of 200 bars/).textContent).toBe(shown);
    // Fit is still there for whoever wants the whole series back
    expect(screen.getByRole('button', { name: /Fit/ })).toBeInTheDocument();
  });

  it('[critical] off, on again, and it zooms on from where it was', () => {
    const { svg } = armedChart();
    fireEvent.wheel(svg, { deltaY: -100, clientX: 390 });
    const shown = screen.getByText(/of 200 bars/).textContent;

    fireEvent.click(screen.getByRole('button', { name: /Zoom on/ }));
    fireEvent.click(screen.getByRole('button', { name: /Zoom off/ }));
    expect(screen.getByText(/of 200 bars/).textContent).toBe(shown);

    expect(fireEvent.wheel(svg, { deltaY: -100, clientX: 390 })).toBe(false);
    expect(screen.getByText(/of 200 bars/).textContent).not.toBe(shown);
  });

  it('says which state it is in, rather than leaving it to be guessed', () => {
    render(
      <PriceChart bars={bars(20)} support={74_400} resistance={80_000} spot={77_172} tf="5m" onTf={noop} />,
    );
    expect(screen.getByText(/zoom is off, so the page scrolls over the chart/)).toBeInTheDocument();
  });
});

/**
 * Zoom that needs no wheel, no arming and no discovery: two buttons that are
 * always there, and on a phone a pinch, a drag on the axis and a double-tap.
 */
describe('zoom without a wheel', () => {
  const fitted = { from: 0, count: 200, yZoom: 1 };
  const plain = (props: Partial<Parameters<typeof PriceChart>[0]> = {}) => {
    const r = render(
      <PriceChart
        bars={bars(200)} support={74_400} resistance={80_000} spot={77_172}
        tf="5m" onTf={noop} {...props}
      />,
    );
    const svg = r.container.querySelector('.price-chart-svg')!;
    svg.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 780, bottom: 360, width: 780, height: 360, x: 0, y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
    return { ...r, svg };
  };
  const shownBars = () => Number(/(\d+) of 200 bars/.exec(screen.getByText(/of 200 bars/).textContent!)![1]);

  it('[critical] the + and − buttons work with zoom off, and never move the page', () => {
    plain();
    expect(screen.getByRole('button', { name: /Zoom off/ })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'zoom in' }));
    const after = shownBars();
    expect(after).toBeLessThan(200);
    expect(screen.getByRole('button', { name: 'zoom out' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'zoom out' }));
    expect(shownBars()).toBeGreaterThan(after);
    fireEvent.click(screen.getByRole('button', { name: /Fit/ }));
    expect(shownBars()).toBe(200);
  });

  it('[critical] + zooms about the newest bar, so the newest bar stays on screen', () => {
    const v = zoomByButton(fitted, 200, false);
    expect(v.from + v.count).toBe(200);
    expect(v.count).toBeLessThan(200);
    // panned back into history, it zooms about the middle instead
    const back = { from: 40, count: 100, yZoom: 1 };
    const w = zoomByButton(back, 200, false);
    expect(w.from + w.count).toBeLessThan(200);
    expect(w.from).toBeGreaterThan(40);
  });

  it('the buttons stop at both ends', () => {
    plain();
    const zoomIn = screen.getByRole('button', { name: 'zoom in' });
    for (let i = 0; i < 40 && !(zoomIn as HTMLButtonElement).disabled; i++) fireEvent.click(zoomIn);
    expect(shownBars()).toBe(12);
    expect(zoomIn).toBeDisabled();
  });

  it('[critical] a pinch: fingers apart shows fewer bars, together shows more, and returning returns the window', () => {
    const inward = pinchZoom(fitted, 200, { anchor: 0.5, ratio: 0.5 });
    expect(inward.count).toBe(100);
    expect(inward.from).toBe(50);
    const outward = pinchZoom({ from: 50, count: 100, yZoom: 1 }, 200, { anchor: 0.5, ratio: 2 });
    expect(outward).toEqual(fitted);
    expect(pinchZoom(fitted, 200, { anchor: 0.5, ratio: 1 })).toEqual(fitted);
    // never past the ends, never below a readable count
    expect(pinchZoom(fitted, 200, { anchor: 0.5, ratio: 0.001 }).count).toBe(12);
    expect(pinchZoom(fitted, 200, { anchor: 0.5, ratio: 50 })).toEqual(fitted);
  });

  it('[critical] two fingers on an armed chart pinch it, through the DOM', () => {
    const { svg } = plain();
    fireEvent.click(screen.getByRole('button', { name: /Zoom off/ }));
    fireEvent.pointerDown(svg, { pointerId: 1, pointerType: 'touch', clientX: 300, clientY: 150 });
    fireEvent.pointerDown(svg, { pointerId: 2, pointerType: 'touch', clientX: 400, clientY: 150 });
    fireEvent.pointerMove(svg, { pointerId: 2, pointerType: 'touch', clientX: 500, clientY: 150 });
    // 100 apart to 200 apart: half the bars
    expect(shownBars()).toBe(100);
    fireEvent.pointerUp(svg, { pointerId: 2, pointerType: 'touch', clientX: 500, clientY: 150 });
    fireEvent.pointerUp(svg, { pointerId: 1, pointerType: 'touch', clientX: 300, clientY: 150 });
    // the finger left behind does not drag the window somewhere new on its way out
    expect(shownBars()).toBe(100);
  });

  it('one finger on an armed chart pans it, and does not scroll the page', () => {
    const { svg } = plain();
    fireEvent.click(screen.getByRole('button', { name: /Zoom off/ }));
    expect(svg).toHaveClass('armed');
    fireEvent.click(screen.getByRole('button', { name: 'zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'zoom in' }));
    const count = shownBars();
    fireEvent.pointerDown(svg, { pointerId: 1, pointerType: 'touch', clientX: 300, clientY: 150 });
    fireEvent.pointerMove(svg, { pointerId: 1, pointerType: 'touch', clientX: 500, clientY: 150 });
    fireEvent.pointerUp(svg, { pointerId: 1, pointerType: 'touch', clientX: 500, clientY: 150 });
    // dragged right: the window walked back into history, the same width
    expect(shownBars()).toBe(count);
    expect(screen.getByRole('button', { name: /Fit/ })).toBeEnabled();
  });

  it('[critical] a drag on the price axis stretches the scale: down is out, up is in', () => {
    expect(stretchByDrag(fitted, 100, 0.02).yZoom).toBeCloseTo(Math.exp(-1), 5);
    expect(stretchByDrag(fitted, -100).yZoom).toBeCloseTo(Math.exp(1), 5);
    // and no further out than this chart's own floor
    expect(stretchByDrag(fitted, 100).yZoom).toBe(0.4);
    expect(stretchByDrag(fitted, 0)).toEqual(fitted);
    expect(stretchByDrag(fitted, 10_000, 0.05).yZoom).toBe(0.05);
    expect(stretchByDrag(fitted, -10_000).yZoom).toBe(8);
    // measured from the drag's start, so a drag back to where it began undoes itself
    expect(stretchByDrag(fitted, 80 - 80)).toEqual(fitted);
  });

  it('dragging the axis on an armed chart brings a wall onto the scale', () => {
    const { svg } = plain({ bars: bars(40) });
    fireEvent.click(screen.getByRole('button', { name: /Zoom off/ }));
    expect(screen.getAllByText(/off the scale/).length).toBeGreaterThan(0);
    // the axis is the right-hand 74px; a long drag down pulls the scale right out
    fireEvent.pointerDown(svg, { pointerId: 1, pointerType: 'mouse', clientX: 750, clientY: 40 });
    fireEvent.pointerMove(svg, { pointerId: 1, pointerType: 'mouse', clientX: 750, clientY: 340 });
    fireEvent.pointerUp(svg, { pointerId: 1, pointerType: 'mouse', clientX: 750, clientY: 340 });
    expect(screen.queryAllByText(/off the scale/)).toHaveLength(0);
  });

  it('two quick taps put the chart back, since a phone has no double-click', () => {
    const { svg } = plain();
    fireEvent.click(screen.getByRole('button', { name: /Zoom off/ }));
    fireEvent.click(screen.getByRole('button', { name: 'zoom in' }));
    expect(shownBars()).toBeLessThan(200);
    for (const _ of [1, 2]) {
      fireEvent.pointerDown(svg, { pointerId: 1, pointerType: 'touch', clientX: 300, clientY: 150 });
      fireEvent.pointerUp(svg, { pointerId: 1, pointerType: 'touch', clientX: 300, clientY: 150 });
    }
    expect(shownBars()).toBe(200);
  });

  it('with zoom off a finger is left to the page: no pan, no pinch', () => {
    const { svg } = plain();
    expect(svg).not.toHaveClass('armed');
    fireEvent.pointerDown(svg, { pointerId: 1, pointerType: 'touch', clientX: 300, clientY: 150 });
    fireEvent.pointerDown(svg, { pointerId: 2, pointerType: 'touch', clientX: 400, clientY: 150 });
    fireEvent.pointerMove(svg, { pointerId: 2, pointerType: 'touch', clientX: 600, clientY: 150 });
    expect(shownBars()).toBe(200);
  });
});

/**
 * Drawn at the size it is shown. A 780-unit canvas squeezed into a phone made
 * every label a smudge; the canvas now takes the card's width.
 */
describe('on a narrow screen', () => {
  it('[critical] draws the canvas at the card width, so text stays text-sized', () => {
    const seen: ((entries: unknown[]) => void)[] = [];
    const RO = vi.fn(function (this: unknown, cb: (entries: unknown[]) => void) {
      seen.push(cb);
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    });
    vi.stubGlobal('ResizeObserver', RO);
    const wide = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 360 });
    try {
      const { container } = render(
        <PriceChart bars={bars(40)} support={74_400} resistance={80_000} spot={77_172} tf="5m" onTf={noop} />,
      );
      // a 360-wide card (jsdom has no padding to take off): a 360-wide canvas, never the fixed 780
      const svg = container.querySelector('.price-chart-svg')!;
      const [, , w, h] = svg.getAttribute('viewBox')!.split(' ').map(Number);
      expect(w).toBe(360);
      expect(h).toBe(250);
      // and the newest bar still stops short of the axis
      const last = [...container.querySelectorAll('.candle-body')].at(-1)!;
      const right = Number(last.getAttribute('x')) + Number(last.getAttribute('width'));
      expect(360 - 74 - right).toBeGreaterThanOrEqual(20);
    } finally {
      if (wide) Object.defineProperty(HTMLElement.prototype, 'clientWidth', wide);
      vi.unstubAllGlobals();
    }
  });
});

/**
 * Room around the newest bar, and walls you can actually reach.
 */
describe('the plot itself', () => {
  it('[critical] leaves room between the newest bar and the price axis', () => {
    // Drawn hard against the axis, the one bar the eye goes to first is the one
    // bar with no room around it, and its own price tag sits on top of it.
    const { container } = render(
      <PriceChart bars={bars(40)} support={74_400} resistance={80_000} spot={77_172} tf="5m" onTf={noop} />,
    );
    const last = [...container.querySelectorAll('.candle-body')].at(-1)!;
    const right = Number(last.getAttribute('x')) + Number(last.getAttribute('width'));
    // 780 wide, a 74-wide price axis: the bars must stop well short of it
    expect(706 - right).toBeGreaterThanOrEqual(20);
  });

  it('[critical] zooming the price scale out brings the walls onto it', () => {
    const { svg } = armedChart({ bars: bars(40) });
    expect(screen.getAllByText(/off the scale/).length).toBeGreaterThan(0);

    // the wheel over the price axis, which is the right-hand gutter
    for (let i = 0; i < 60; i++) fireEvent.wheel(svg, { deltaY: 100, clientX: 750 });

    expect(screen.queryAllByText(/off the scale/)).toHaveLength(0);
    // both walls are now on the axis — and the axis itself reaches them, which
    // is why each number can appear more than once
    expect(screen.getAllByText('74,400').length).toBeGreaterThan(0);
    expect(screen.getAllByText('80,000').length).toBeGreaterThan(0);
  });
});
