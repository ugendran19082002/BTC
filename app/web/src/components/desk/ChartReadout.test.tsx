import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ChartInsight, IndicatorSummary, PatternStrip } from '@/components/desk/ChartReadout';
import type { StateIndicator, StatePattern } from '@/api/desk';

const pattern = (over: Partial<StatePattern> = {}): StatePattern => ({
  name: 'Ascending Triangle', bias: 'BULLISH', kind: 'structure',
  note: 'Higher lows into one flat ceiling', barsAgo: 0, ...over,
});

const indicator = (over: Partial<StateIndicator> = {}): StateIndicator => ({
  key: 'rsi', label: 'RSI (14)', value: 62, text: '62', read: 'Neutral', bias: 'NEUTRAL', gauge: 0.62, ...over,
});

describe('the pattern strip', () => {
  it('[critical] names each shape with its bias and what it means', () => {
    render(<PatternStrip patterns={[
      pattern(),
      pattern({ name: 'Resistance Test (3x)', bias: 'BEARISH', note: 'Tested 86,800 3 times without going through' }),
    ]} />);
    expect(screen.getByText('Ascending Triangle')).toBeInTheDocument();
    expect(screen.getByText('Bullish')).toBeInTheDocument();
    expect(screen.getByText('Resistance Test (3x)')).toBeInTheDocument();
    expect(screen.getByText('Bearish')).toBeInTheDocument();
    expect(screen.getByText(/Tested 86,800 3 times/)).toBeInTheDocument();
  });

  it('a level test keeps its drawing when it carries a touch count', () => {
    /*
     * The glyph is matched on what the name starts with, not on the whole
     * string: a shape that vanished the third time a level was touched would
     * be a small, silly bug, and the third touch is when it matters most.
     */
    const { container } = render(<PatternStrip patterns={[pattern({ name: 'Resistance Test (3x)', bias: 'BEARISH' })]} />);
    const glyph = container.querySelector('.bt-readout__glyph')!;
    expect(glyph.querySelectorAll('path').length).toBeGreaterThan(1);
  });

  it('says so rather than showing an empty box when nothing is named', () => {
    render(<PatternStrip patterns={[]} />);
    expect(screen.getByText('Nothing named on these bars.')).toBeInTheDocument();
  });
});

describe('the indicator summary', () => {
  it('[critical] a reading with natural bounds gets a dial; one without does not', () => {
    // MACD's histogram has no top, so a dial would be inventing one.
    const { container } = render(<IndicatorSummary items={[
      indicator(),
      indicator({ key: 'macd', label: 'MACD', text: '+41', read: 'Bullish', bias: 'BULLISH', gauge: null }),
    ]} />);
    expect(container.querySelectorAll('.bt-readout__dial')).toHaveLength(1);
    expect(screen.getByText('62')).toBeInTheDocument();
    expect(screen.getByText('+41')).toBeInTheDocument();
    expect(screen.getByText('Bullish')).toBeInTheDocument();
  });

  it('a reading that could not be taken shows a dash, not a zero', () => {
    render(<IndicatorSummary items={[indicator({ value: null, text: '—', read: 'No reading', gauge: null })]} />);
    const cell = screen.getByText('RSI (14)').closest('li')!;
    expect(within(cell).getByText('—')).toBeInTheDocument();
    expect(within(cell).queryByText('0')).toBeNull();
  });

  it('shows nothing rather than an empty grid when there are no readings', () => {
    render(<IndicatorSummary items={[]} />);
    expect(screen.getByText('No readings yet.')).toBeInTheDocument();
  });
});

describe('the insight line', () => {
  it('[critical] prints the sentence the server wrote, both branches and all', () => {
    // Assembled on the server so the sentence, the card and the journal can
    // never drift apart; the component only prints it.
    const sentence = 'If 86,800 breaks and a 15m candle closes above it with volume, the next move is towards '
      + '87,200 – 87,600. If it is rejected, watch 86,200 for the short.';
    render(<ChartInsight insight={sentence} />);
    expect(screen.getByText(sentence)).toBeInTheDocument();
  });
});
