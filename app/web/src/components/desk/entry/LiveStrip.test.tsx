import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { LiveStrip, placeOf } from './LiveStrip';

const LONG = { entryLo: 84_120, entryHi: 84_160, stop: 83_980, tp1: 84_300, tp2: null, tp3: null, tpWhy: [], rr: 1.9 };
const SHORT = { entryLo: 84_391, entryHi: 84_523, stop: 84_825, tp1: 84_288, tp2: null, tp3: null, tpWhy: [], rr: 1.9 };

describe('the live price against a TRADE', () => {
  it('[critical] a long: above the zone, in it, under it, past the stop, at TP1', () => {
    expect(placeOf(84_200, LONG, 'long')).toBe('above');
    expect(placeOf(84_160, LONG, 'long')).toBe('in');
    expect(placeOf(84_120, LONG, 'long')).toBe('in');
    expect(placeOf(84_050, LONG, 'long')).toBe('below');
    expect(placeOf(83_980, LONG, 'long')).toBe('past-sl');
    expect(placeOf(84_300, LONG, 'long')).toBe('tp1');
  });

  it('[critical] a short is the mirror', () => {
    expect(placeOf(84_350, SHORT, 'short')).toBe('below');
    expect(placeOf(84_391, SHORT, 'short')).toBe('in');
    expect(placeOf(84_600, SHORT, 'short')).toBe('above');
    expect(placeOf(84_825, SHORT, 'short')).toBe('past-sl');
    expect(placeOf(84_288, SHORT, 'short')).toBe('tp1');
  });

  it('[critical] the points: to the fill (the zone\'s near edge), to the stop, to TP1', () => {
    render(<LiveStrip plan={LONG} dir="long" ltp={{ price: 84_200, at: 1_000 }} now={2_000} />);
    const s = screen.getByLabelText('live price');
    expect(s).toHaveTextContent('LTP 84,200');
    expect(s).toHaveTextContent('40 pts above the zone');
    expect(s).toHaveTextContent('to entry 40 pts');
    expect(s).toHaveTextContent('to SL 220 pts');
    expect(s).toHaveTextContent('to TP1 100 pts');
  });

  it('in the zone it says so, loudly', () => {
    render(<LiveStrip plan={SHORT} dir="short" ltp={{ price: 84_450, at: 1_000 }} now={2_000} />);
    expect(within(screen.getByLabelText('live price')).getByText('IN THE ENTRY ZONE')).toBeInTheDocument();
  });

  it('with the stream down it says the live price is unavailable, never a stale number as live', () => {
    render(<LiveStrip plan={LONG} dir="long" ltp={null} />);
    expect(screen.getByText(/Live price unavailable/)).toBeInTheDocument();
  });
});
