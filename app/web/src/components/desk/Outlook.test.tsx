import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Outlook, chartWords } from '@/components/desk/Outlook';
import type { ChainContext, DirectionVerdict, MeasuredRow, Outlook as OutlookData, OutlookRow } from '@/types/desk';

/**
 * Where BTC could be, horizon by horizon.
 *
 * The property this card exists to protect: **it never prints a directional
 * probability.** The desk measured the direction over 105,119 windows and it is
 * a coin flip at every horizon. So the three figures on each card are Below,
 * Inside and Above the band the option market is charging for — measured — and
 * the arrow is a score from that timeframe's own indicators, labelled as one.
 */

const row = (over: Partial<OutlookRow> = {}): OutlookRow => ({
  label: '1h', minutes: 60, spot: 75_820,
  impliedUsd: 330, low: 75_490, high: 76_150,
  measured68Pct: 0.316, measured95Pct: 0.95,
  measuredLow: 75_580, measuredHigh: 76_060,
  below: 0.16, inside: 0.70, above: 0.14,
  pUp: 0.5004,
  richness: 1.01, priced: 'fair',
  score: 0.42, lean: 'bullish',
  why: 'EMAs rising, RSI 66, higher highs, ADX 28',
  isExpiry: false,
  ...over,
});

const data = (over: Partial<OutlookData> = {}): OutlookData => ({
  rows: [
    row({ label: '5m', minutes: 5, score: -0.2, lean: 'flat' }),
    row(),
    row({ label: '30m', minutes: 30, score: null, lean: null, why: 'no bars at this horizon — the band is measured, the direction is not read' }),
    row({ label: 'to settlement · 9.6h', minutes: 576, isExpiry: true, score: null, lean: null }),
  ],
  consensus: 0.31,
  bullish: 1, bearish: 0, flat: 1, scored: 2,
  agreement: '1 of 2 bullish, 1 flat',
  directionEdgePts: 0.62,
  sampleWindows: 105_119,
  ...over,
});

describe('what the next few hours could do', () => {
  it('[critical] the price is said once, and each card carries only its band', () => {
    // It was on every card: ten identical numbers, because the measured drift
    // over these horizons is nil. Nine repetitions read as a broken panel.
    render(<Outlook outlook={data()} />);
    expect(screen.getAllByText('75,820')).toHaveLength(1);
    expect(screen.getByText(/each card shows how far it could move from here/)).toBeInTheDocument();
    expect(within(screen.getByLabelText('1h')).getByText('75,490 – 76,150')).toBeInTheDocument();
  });

  it('[critical] each card leads with how far, then whether options are cheap or rich for it', () => {
    // Laid out like a gauge: the move is the headline, and the figure that
    // actually varies for a seller -- priced against history -- is a chip.
    render(<Outlook outlook={data({
      rows: [
        row({ label: '5m', richness: 1.00, priced: 'fair' }),
        row({ label: '12h', richness: 0.88, priced: 'cheap' }),
        row({ label: '24h', richness: 1.20, priced: 'rich' }),
      ],
    })} />);
    expect(within(screen.getByLabelText('5m')).getByText('±$330')).toBeInTheDocument();
    expect(within(screen.getByLabelText('5m')).getByText('Premium: fair')).toBeInTheDocument();
    const cheap = within(screen.getByLabelText('12h')).getByText('Premium: low');
    expect(cheap.className).toContain('cheap');
    // the ratio and what it means for a seller are on the chip, on hover
    expect(cheap.getAttribute('title')).toMatch(/0\.88× the move BTC usually makes here — a seller is paid less than the usual risk/);
    expect(within(screen.getByLabelText('24h')).getByText('Premium: high').getAttribute('title')).toMatch(/paid more than the usual risk/);
  });

  it('[critical] the three figures are Below, Inside and Above the band — not a direction', () => {
    render(<Outlook outlook={data()} />);
    const one = within(screen.getByLabelText('1h'));
    expect(one.getByText('Falls below').nextSibling).toHaveTextContent('16%');
    expect(one.getByText('Stays in range').nextSibling).toHaveTextContent('70%');
    expect(one.getByText('Rises above').nextSibling).toHaveTextContent('14%');
    // The desk's own card prints no Down or Up: it has nothing measured to say
    // about direction. Those words belong to the measured card below, and only there.
    expect(screen.queryByText(/^Down$/)).toBeNull();
    expect(screen.queryByText(/^Up$/)).toBeNull();
  });

  it('[critical] says on its face that the measured direction is a coin flip', () => {
    render(<Outlook outlook={data()} />);
    expect(screen.getByText(/coin toss \(within 0\.6 points of 50\/50\)/)).toBeInTheDocument();
  });

  it('[critical] a horizon with no bars says so rather than drawing a flat arrow', () => {
    render(<Outlook outlook={data()} />);
    const half = within(screen.getByLabelText('30m'));
    expect(half.getByText('no chart')).toBeInTheDocument();
    expect(half.getByText('75,490 – 76,150')).toBeInTheDocument();
  });

  it('a band the market cannot price says so instead of showing a number', () => {
    render(<Outlook outlook={data({ rows: [row({ impliedUsd: null, low: null, high: null, below: null, inside: null, above: null, richness: null, priced: null })] })} />);
    expect(screen.getByText('can’t price it')).toBeInTheDocument();
    expect(screen.getByText('nothing to compare')).toBeInTheDocument();
    expect(within(screen.getByLabelText('1h')).getByText('Stays in range').nextSibling).toHaveTextContent('—');
  });

  it('[critical] a band that contains more than two thirds of history is marked', () => {
    // The seller's question: is the market charging for more move than it gets?
    render(<Outlook outlook={data()} />);
    expect(within(screen.getByLabelText('1h')).getByText('70%').className).toContain('up');
    render(<Outlook outlook={data({ rows: [row({ inside: 0.5 })] })} />);
    expect(within(screen.getAllByLabelText('1h')[1]!).getByText('50%').className).not.toContain('up');
  });

  it('[critical] the largest of the three is lit, like a gauge reading', () => {
    render(<Outlook outlook={data()} />);
    const one = within(screen.getByLabelText('1h'));
    expect(one.getByText('Stays in range').parentElement!.className).toContain('top');
    expect(one.getByText('Falls below').parentElement!.className).not.toContain('top');
    expect(one.getByText('Rises above').parentElement!.className).not.toContain('top');
  });

  it('[critical] the chart reads in words, and the score and its reasons are on hover', () => {
    render(<Outlook outlook={data()} />);
    const arrow = within(screen.getByLabelText('1h')).getByText('Chart up').closest('div')!;
    expect(arrow.getAttribute('title')).toMatch(/Chart score \+0\.42 \(−1 down … \+1 up\): EMAs rising, RSI 66/);
    expect(arrow.getAttribute('title')).toMatch(/not where BTC goes next/);
    expect(arrow.className).toContain('up');
    expect(screen.queryByText(/\+0\.42/)).toBeNull();
  });

  it('a strong chart says strong; a small score says flat', () => {
    expect(chartWords({ score: 0.84, lean: 'bullish' })).toBe('Chart up · strong');
    expect(chartWords({ score: 0.42, lean: 'bullish' })).toBe('Chart up');
    expect(chartWords({ score: -0.38, lean: 'bearish' })).toBe('Chart down');
    expect(chartWords({ score: 0.18, lean: 'flat' })).toBe('Chart flat');
    expect(chartWords({ score: null, lean: null })).toBe('no chart');
  });

  it('usually is said in dollars, like the headline', () => {
    render(<Outlook outlook={data()} />);
    // 75,820 × 0.316% ≈ $240
    expect(within(screen.getByLabelText('1h')).getByText('usually ±$240')).toBeInTheDocument();
  });

  it('a one-line legend says how to read the desk\'s own cards', () => {
    render(<Outlook outlook={data()} />);
    expect(screen.getByText(/How to read a card:/)).toBeInTheDocument();
  });

  it('[critical] the consensus says how many timeframes it could read', () => {
    render(<Outlook outlook={data()} />);
    expect(screen.getByText('Charts: 1 of 2 up, 1 flat')).toBeInTheDocument();
    expect(screen.getByText('Charts: 1 of 2 up, 1 flat').getAttribute('title')).toMatch(/\+0\.31/);
    // the header's own caveat (the legend says it too, which is fine)
    expect(screen.getByText('· recent trend, not a forecast')).toBeInTheDocument();
  });

  it('nothing readable says so rather than showing a zero', () => {
    render(<Outlook outlook={data({ consensus: null, scored: 0, agreement: 'no timeframe could be read' })} />);
    expect(screen.getByText('No timeframe could be read')).toBeInTheDocument();
  });

  it('[critical] the maths is one tap away, formula by formula', () => {
    render(<Outlook outlook={data()} />);
    expect(screen.queryByLabelText('how this is worked out')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /How this is worked out/ }));
    const maths = within(screen.getByLabelText('how this is worked out'));
    expect(maths.getByText('EM(t) = spot × IV × √(t ÷ 365d)')).toBeInTheDocument();
    expect(maths.getByText(/score = 0\.5·EMA stack/)).toBeInTheDocument();
    expect(maths.getByText(/P\(up\) ≈ 0\.50 at every horizon/)).toBeInTheDocument();
    expect(screen.getByLabelText('how this is worked out')).toHaveTextContent('1,05,119 windows');
  });

  it('the settlement horizon is marked as the one that matters', () => {
    render(<Outlook outlook={data()} />);
    expect(screen.getByLabelText('to settlement · 9.6h').className).toContain('expiry');
  });
});

/**
 * The measured card, in the reference's shape.
 *
 * Asked for on 17 September: a price, a range, an arrow and Down / Side / Up on
 * every card, like the reference image. Every figure comes from the analytics
 * service's measurement -- what followed moments like this one -- and the
 * properties pinned here are about honesty in that shape: the arrow only on a
 * lean that held, the reason in words, and the desk's own card back whenever
 * the service did not answer.
 */
describe('the measured card', () => {
  const measured = (over: Partial<MeasuredRow> = {}): MeasuredRow => ({
    label: '1h', minutes: 60, measuredMinutes: 60,
    projected: 78_522, low: 78_208, high: 78_812,
    pDown: 0.337, pSide: 0.271, pUp: 0.392,
    sideBandPct: 0.119, sideBandUsd: 93, arrow: 'up', calm: 'livelier', windows: 91_985,
    basis: { feature: 'momentum', bucket: 'down', words: 'BTC fell over the last hour', windows: 91_985, independent: 7_665, leanHolds: true, sideHolds: true },
    ...over,
  });
  const withMeasured = (rows: OutlookRow[]) => data({ rows, model: { name: 'measured-states-v1', measuredAt: '2026-09-17' } });

  it('[critical] shows the price, the range and the three outcomes, with the largest lit', () => {
    render(<Outlook outlook={withMeasured([row({ measured: measured() })])} />);
    const card = within(screen.getByLabelText('1h'));
    expect(card.getByText('78,522')).toBeInTheDocument();
    expect(card.getByText('78,208 – 78,812')).toBeInTheDocument();
    expect(card.getByText('Down').nextSibling).toHaveTextContent('34%');
    expect(card.getByText('Side').nextSibling).toHaveTextContent('27%');
    expect(card.getByText('Up').nextSibling).toHaveTextContent('39%');
    expect(card.getByText('Up').parentElement!.className).toContain('top');
    expect(card.getByText('Down').parentElement!.className).not.toContain('top');
  });

  it('[critical] says why, in words, and that it is measured', () => {
    render(<Outlook outlook={withMeasured([row({ measured: measured() })])} />);
    expect(screen.getByText('BTC fell over the last hour · livelier')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'leans up, measured' })).toBeInTheDocument();
    expect(screen.getByText(/Measured, not guessed: a lean shows only when it held in 2024, 2025 and 2026/)).toBeInTheDocument();
  });

  it('[critical] only an outcome that held is lit, never simply the largest', () => {
    // calmer held, lean did not: Side lights, and the even Down/Up split lights neither
    let view = render(<Outlook outlook={withMeasured([row({ measured: measured({
      arrow: 'flat', calm: 'calmer', pDown: 0.28, pSide: 0.44, pUp: 0.28,
      basis: { feature: 'momentum', bucket: 'flat', words: 'the last hour was quiet', windows: 93_436, independent: 7_786, leanHolds: false, sideHolds: true },
    }) })])} />);
    let card = within(screen.getByLabelText('1h'));
    expect(card.getByText('Side').parentElement!.className).toContain('top');
    expect(card.getByText('Down').parentElement!.className).not.toContain('top');
    expect(card.getByText('Up').parentElement!.className).not.toContain('top');
    view.unmount();

    // livelier held: less likely to stay in range, so Side must not light -- nothing does
    view = render(<Outlook outlook={withMeasured([row({ measured: measured({
      arrow: 'flat', calm: 'livelier', pDown: 0.355, pSide: 0.29, pUp: 0.355,
      basis: { feature: 'momentum', bucket: 'down', words: 'BTC fell over the last 6 hours', windows: 90_093, independent: 1_251, leanHolds: false, sideHolds: true },
    }) })])} />);
    card = within(screen.getByLabelText('1h'));
    for (const w of ['Down', 'Side', 'Up']) expect(card.getByText(w).parentElement!.className).not.toContain('top');
    expect(card.getByText('BTC fell over the last 6 hours · livelier')).toBeInTheDocument();
    view.unmount();

    // nothing held: Up is the largest (the sample's drift) and still does not light
    render(<Outlook outlook={withMeasured([row({ measured: measured({ arrow: 'flat', basis: null, calm: null, pDown: 0.32, pSide: 0.33, pUp: 0.35 }) })])} />);
    card = within(screen.getByLabelText('1h'));
    for (const w of ['Down', 'Side', 'Up']) expect(card.getByText(w).parentElement!.className).not.toContain('top');
  });

  it('[critical] no lean that held draws no direction and says about even', () => {
    render(<Outlook outlook={withMeasured([row({ measured: measured({ arrow: 'flat', basis: null, calm: null, pDown: 0.33, pSide: 0.34, pUp: 0.33 }) })])} />);
    expect(screen.getByRole('img', { name: 'no lean that held' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /leans/ })).toBeNull();
    expect(screen.getByText('no lean held — about even')).toBeInTheDocument();
  });

  it('the settlement card reads Below, Within and Above, and names its hours', () => {
    const expiry = row({ label: 'to settlement · 9.6h', minutes: 576, isExpiry: true, score: null, lean: null,
      measured: measured({ label: 'to settlement · 9.6h', minutes: 576, measuredMinutes: 720, arrow: 'flat', basis: null }) });
    render(<Outlook outlook={withMeasured([expiry])} />);
    const card = within(screen.getByLabelText('to settlement · 9.6h'));
    expect(card.getByText('By expiry · 9.6h')).toBeInTheDocument();
    for (const w of ['Below', 'Within', 'Above']) expect(card.getByText(w)).toBeInTheDocument();
    expect(card.getByText('no lean held — about even').getAttribute('title')).toMatch(/answered from the 720-minute horizon/);
  });

  it('[critical] a horizon the service did not answer keeps the desk\'s own card', () => {
    render(<Outlook outlook={withMeasured([row({ measured: measured() }), row({ label: '2h', measured: null })])} />);
    expect(within(screen.getByLabelText('1h')).getByText('Side')).toBeInTheDocument();
    expect(within(screen.getByLabelText('2h')).getByText('Stays in range')).toBeInTheDocument();
  });

  it('[critical] with no measured model at all, nothing about the old card changes', () => {
    render(<Outlook outlook={data()} />);
    expect(screen.queryByText('Side')).toBeNull();
    expect(screen.getByText(/coin toss \(within 0\.6 points of 50\/50\)/)).toBeInTheDocument();
  });

  it('[critical] each measured card says where Side ends, so 33% is not read against the ±1% panel', () => {
    render(<Outlook outlook={withMeasured([row({ measured: measured() })])} />);
    expect(within(screen.getByLabelText('1h')).getByText('Side = ±$93 (0.12%)')).toBeInTheDocument();
  });

  it('the maths panel explains the measured model when it answered', () => {
    render(<Outlook outlook={withMeasured([row({ measured: measured() })])} />);
    fireEvent.click(screen.getByRole('button', { name: /How this is worked out/ }));
    const maths = within(screen.getByLabelText('how this is worked out'));
    expect(maths.getByText(/P\(up\) = N\(−½σ√t\) ≈ 50%/)).toBeInTheDocument();
    expect(maths.getByText(/τₕ = tercile of \|returnₕ\|/)).toBeInTheDocument();
    expect(maths.getByText(/Kept only if it pointed the same way in 2024, 2025 and 2026/)).toBeInTheDocument();
  });
});

describe('the header', () => {
  const direction = (over: Partial<DirectionVerdict> = {}): DirectionVerdict => ({
    score: 0.08, side: null, inputs: [], gates: [], passed: 3, readable: 5, confirmed: false,
    summary: 'No clear lean either way (+0.08)', ...over,
  });

  it('[critical] the overall lean is boxed in the header, said once, with its words', () => {
    render(<Outlook outlook={data()} direction={direction()} />);
    const box = within(screen.getByLabelText('overall lean'));
    expect(box.getByText('No clear lean')).toBeInTheDocument();
    // one score on the screen -- the verdict line under it no longer repeats it
    expect(screen.getAllByLabelText('direction score')).toHaveLength(1);
    expect(box.getByLabelText('direction score')).toHaveTextContent('+0.08');
    expect(screen.getByText('3 of 5 checks passed · show the working')).toBeInTheDocument();
  });

  it('a confirmed side reads in its own colour, with the minus sign the desk uses', () => {
    render(<Outlook outlook={data()} direction={direction({ score: -0.61, side: 'bearish', confirmed: true, passed: 4 })} />);
    const box = within(screen.getByLabelText('overall lean'));
    expect(box.getByText('Leaning down · confirmed')).toHaveClass('down');
    expect(box.getByLabelText('direction score')).toHaveTextContent('−0.61');
  });

  it('without a verdict there is no lean box, and the title still stands', () => {
    render(<Outlook outlook={data()} />);
    expect(screen.queryByLabelText('overall lean')).toBeNull();
    expect(screen.getByRole('heading', { name: 'How far could BTC move, and when' })).toBeInTheDocument();
  });

  it('[critical] folds to its header and lean box, and remembers it', () => {
    localStorage.clear();
    const { unmount } = render(<Outlook outlook={data()} direction={direction()} />);
    fireEvent.click(screen.getByRole('button', { name: 'fold the outlook' }));
    expect(screen.queryByLabelText('horizons')).toBeNull();
    expect(screen.getByLabelText('overall lean')).toBeInTheDocument();
    unmount();
    render(<Outlook outlook={data()} direction={direction()} />);
    expect(screen.queryByLabelText('horizons')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'open the outlook' }));
    expect(screen.getByLabelText('horizons')).toBeInTheDocument();
  });
});

/*
 * The option board, under the cards.
 *
 * Asked on 17 September to use OI, volume, ΔOI, IV, skew and PCR in the
 * prediction. What the strip must never do is let a reading nobody measured —
 * or one that was measured and did not hold — look like it moved a figure.
 */
describe('the market context strip', () => {
  const ctx = (over: Partial<ChainContext> = {}): ChainContext => ({
    feature: 'implied_move', value: 1.31, bucket: 'large',
    words: 'Options price a large move to settlement',
    measured: true, leanHolds: false, sideHolds: true, calm: 'livelier',
    pDown: 0.361, pSide: 0.193, pUp: 0.447, windows: 244,
    ...over,
  });
  const structure = {
    pcrOi: 0.34, ivSkewPts: 1.2,
    ceOiWall: { strike: 78_400, value: 1 }, peOiWall: { strike: 72_800, value: 1 },
    maxPain: { strike: 76_000, payoutUsd: 1 },
  } as never;

  it('[critical] a reading that held says so; one that did not is marked as measured and unheld', () => {
    render(<Outlook outlook={data({ context: [ctx(), ctx({ feature: 'skew', value: -0.02, bucket: 'even', words: 'Puts and calls are priced evenly', sideHolds: false, calm: null })] })} />);
    const strip = within(screen.getByLabelText('market context'));
    const implied = within(strip.getByLabelText('Implied move'));
    expect(implied.getByText('1.31%')).toBeInTheDocument();
    expect(implied.getByText('counts — livelier to settlement')).toBeInTheDocument();
    expect(within(strip.getByLabelText('Skew (puts vs calls)')).getByText('measured · did not hold')).toBeInTheDocument();
  });

  it('[critical] a reading with no history says so rather than looking like a signal', () => {
    render(<Outlook outlook={data()} structure={structure} />);
    const strip = within(screen.getByLabelText('market context'));
    for (const label of ['Put/call open interest', 'IV skew', 'OI walls', 'Max pain']) {
      expect(within(strip.getByLabelText(label)).getByText('no history yet')).toBeInTheDocument();
    }
    expect(within(strip.getByLabelText('OI walls')).getByText('72,800 – 78,400')).toBeInTheDocument();
  });

  it('says plainly that only a reading which held may move a figure', () => {
    render(<Outlook outlook={data({ context: [ctx()] })} />);
    expect(screen.getByText(/it says how far, never which way/)).toBeInTheDocument();
  });

  it('put/call volume reads as a ratio, not a logarithm', () => {
    render(<Outlook outlook={data({ context: [ctx({ feature: 'pcr_volume', value: Math.log(2), bucket: 'more_puts', words: 'More puts than calls are trading', sideHolds: false, calm: null })] })} />);
    expect(within(screen.getByLabelText('Put/call volume')).getByText('2.00× puts')).toBeInTheDocument();
  });

  it('a board the service never answered about draws no strip at all', () => {
    render(<Outlook outlook={data()} />);
    expect(screen.queryByLabelText('market context')).toBeNull();
  });
});

