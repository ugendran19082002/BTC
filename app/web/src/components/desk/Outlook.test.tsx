import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Outlook } from '@/components/desk/Outlook';
import type { Outlook as OutlookData, OutlookRow } from '@/types/desk';

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
    expect(screen.getByText(/each card is the band around it/)).toBeInTheDocument();
    expect(within(screen.getByLabelText('1h')).getByText('75,490 – 76,150')).toBeInTheDocument();
  });

  it('[critical] each card leads with the one figure that varies across the row', () => {
    // Below/inside/above barely move: both bands scale with root-t, so their
    // ratio is near-constant by construction. This does move.
    render(<Outlook outlook={data({
      rows: [
        row({ label: '5m', richness: 1.00, priced: 'fair' }),
        row({ label: '12h', richness: 0.88, priced: 'cheap' }),
        row({ label: '24h', richness: 1.20, priced: 'rich' }),
      ],
    })} />);
    expect(within(screen.getByLabelText('5m')).getByText(/1\.00× history/)).toBeInTheDocument();
    const cheap = within(screen.getByLabelText('12h'));
    expect(cheap.getByText(/0\.88× history/)).toBeInTheDocument();
    expect(cheap.getByText('market pays less')).toBeInTheDocument();
    expect(within(screen.getByLabelText('24h')).getByText('market pays more')).toBeInTheDocument();
  });

  it('[critical] the three figures are Below, Inside and Above the band — not a direction', () => {
    render(<Outlook outlook={data()} />);
    const one = within(screen.getByLabelText('1h'));
    expect(one.getByText('Below').nextSibling).toHaveTextContent('16%');
    expect(one.getByText('Inside').nextSibling).toHaveTextContent('70%');
    expect(one.getByText('Above').nextSibling).toHaveTextContent('14%');
    // the words a directional forecast would use appear nowhere
    expect(screen.queryByText(/^Down$/)).toBeNull();
    expect(screen.queryByText(/^Up$/)).toBeNull();
  });

  it('[critical] says on its face that the measured direction is a coin flip', () => {
    render(<Outlook outlook={data()} />);
    expect(screen.getByText(/within 0\.6 points of a coin flip/)).toBeInTheDocument();
  });

  it('[critical] a horizon with no bars says "not read" rather than drawing a flat arrow', () => {
    render(<Outlook outlook={data()} />);
    const half = within(screen.getByLabelText('30m'));
    expect(half.getByText('not read')).toBeInTheDocument();
    expect(half.getByText('75,490 – 76,150')).toBeInTheDocument();
  });

  it('a band the market cannot price says so instead of showing a number', () => {
    render(<Outlook outlook={data({ rows: [row({ impliedUsd: null, low: null, high: null, below: null, inside: null, above: null, richness: null, priced: null })] })} />);
    expect(screen.getByText('no band')).toBeInTheDocument();
    expect(screen.getByText('nothing to compare')).toBeInTheDocument();
    expect(within(screen.getByLabelText('1h')).getByText('Inside').nextSibling).toHaveTextContent('—');
  });

  it('[critical] a band that contains more than two thirds of history is marked', () => {
    // The seller's question: is the market charging for more move than it gets?
    render(<Outlook outlook={data()} />);
    expect(within(screen.getByLabelText('1h')).getByText('70%').className).toContain('up');
    render(<Outlook outlook={data({ rows: [row({ inside: 0.5 })] })} />);
    expect(within(screen.getAllByLabelText('1h')[1]!).getByText('50%').className).not.toContain('up');
  });

  it('the arrow carries the reading it came from', () => {
    render(<Outlook outlook={data()} />);
    const arrow = within(screen.getByLabelText('1h')).getByText(/\+0\.42/).closest('div')!;
    expect(arrow.getAttribute('title')).toMatch(/EMAs rising, RSI 66/);
    expect(arrow.className).toContain('up');
  });

  it('[critical] the consensus says how many timeframes it could read', () => {
    render(<Outlook outlook={data()} />);
    expect(screen.getByText('+0.31')).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 bullish, 1 flat/)).toBeInTheDocument();
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
