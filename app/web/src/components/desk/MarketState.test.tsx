import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MarketState } from '@/components/desk/MarketState';
import type { MarketStateResponse, StateHistoryRow } from '@/api/desk';

const base: MarketStateResponse = {
  at: Date.UTC(2026, 8, 23, 11, 54),
  tf: '15m',
  bars: 60,
  state: {
    event: 'BREAKOUT_WATCH',
    stage: 'WATCH',
    side: 'UP',
    confirmed: false,
    level: { resistance: 86_800, support: 86_200 },
    against: 86_800,
    distance: -246,
    confidence: 76,
    parts: { levelBreak: 0.3, volume: 1, candle: 0.8, retest: 0, flow: 0.9, mtf: 0.71, regime: 1 },
    checks: [
      { label: 'Close over 86,800', ok: false },
      { label: 'Volume over 1.5x', ok: true },
      { label: 'Open interest building', ok: null },
    ],
    plan: { side: 'UP', trigger: 86_800, target1: 87_200, target2: 87_600, invalidation: 86_400 },
    plans: {
      up: { side: 'UP', trigger: 86_800, target1: 87_200, target2: 87_600, invalidation: 86_400 },
      down: { side: 'DOWN', trigger: 86_200, target1: 85_800, target2: 85_400, invalidation: 86_600 },
    },
    volumeRatio: 1.8,
    volumeRead: 'STRONG',
    words: 'Price is near resistance. A close over 86,800 is the break.',
    insight: 'If 86,800 breaks and a 15m candle closes above it with volume, the next move is towards 87,200 – 87,600. If it is rejected, watch 86,200 for the short.',
  },
  lines: [],
  patterns: {
    all: [],
    shown: [
      { name: 'Ascending Triangle', bias: 'BULLISH', kind: 'structure', note: 'Higher lows into one flat ceiling', barsAgo: 0 },
      { name: 'Hammer', bias: 'BULLISH', kind: 'candle', note: 'A long tail under a fall', barsAgo: 2 },
    ],
  },
  indicators: {
    all: [],
    shown: [
      { key: 'rsi', label: 'RSI (14)', value: 62, text: '62', read: 'Bullish', bias: 'BULLISH', gauge: 0.62 },
      { key: 'volume', label: 'Volume', value: 1.8, text: '1.8x', read: 'Increasing', bias: 'NEUTRAL', gauge: 0.6 },
    ],
  },
  inputs: { atr: 400, oiChangePct: 2.1, cvdSlope: 120, aggressorBuyPct: 58, mtf: { up: 5, down: 2, total: 7 }, regime: 'TREND_UP' },
};

const withState = (over: Partial<MarketStateResponse['state']>): MarketStateResponse =>
  ({ ...base, state: { ...base.state, ...over } });

describe('the market-state card', () => {
  it('[critical] says "likely" for a setup and never calls it confirmed', () => {
    /*
     * The distinction the whole card exists to keep. A watch is a thing that
     * might happen; dressing it like a thing that has is how somebody sells
     * into a level that never broke.
     */
    render(<MarketState data={base} tf="15m" />);
    expect(screen.getByText(/Breakout likely/)).toBeInTheDocument();
    expect(screen.queryByText(/Breakout confirmed/)).toBeNull();
    expect(screen.getByText('Not confirmed')).toBeInTheDocument();
  });

  it('[critical] a confirmed break says so, in its own words', () => {
    render(<MarketState data={withState({ event: 'BREAKOUT_CONFIRMED', stage: 'CONFIRMED', confirmed: true })} tf="15m" />);
    expect(screen.getByText('Breakout confirmed')).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
  });

  it('[critical] the number is labelled a score, not a probability', () => {
    // Nothing here is calibrated against history yet, and a number that looks
    // like a probability and is not is worse than no number at all.
    render(<MarketState data={base} tf="15m" />);
    expect(screen.getByText('76')).toBeInTheDocument();
    expect(screen.getByText('score')).toBeInTheDocument();
    expect(screen.queryByText(/76%/)).toBeNull();
    expect(screen.queryByText(/probability/i)).toBeNull();
  });

  it('shows both sides’ plans at once, with the range between them', () => {
    render(<MarketState data={base} tf="15m" />);
    expect(screen.getByText('> 86,800')).toBeInTheDocument();
    expect(screen.getByText('< 86,200')).toBeInTheDocument();
    expect(screen.getByText('86,200 – 86,800')).toBeInTheDocument();
  });

  it('[critical] a reading that could not be taken is not shown as a failed one', () => {
    render(<MarketState data={base} tf="15m" />);
    const checks = screen.getByText('Open interest building').closest('li')!;
    expect(within(checks).getByText('not measured')).toBeInTheDocument();
    expect(checks.className).toContain('is-unknown');
  });

  it('the tabs swap what is under the banner, and the plans stay put', () => {
    render(<MarketState data={base} tf="15m" />);
    expect(screen.getByText('Volume over 1.5x')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Patterns' }));
    expect(screen.getByText('Ascending Triangle')).toBeInTheDocument();
    expect(screen.queryByText('Volume over 1.5x')).toBeNull();
    expect(screen.getByText('> 86,800')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Indicators' }));
    expect(screen.getByText('RSI (14)')).toBeInTheDocument();
    expect(screen.getByText('1.8x')).toBeInTheDocument();
  });

  it('[critical] the targets and the stop are on the card under every tab', () => {
    /*
     * They were folded away on every tab but Levels, which made the numbers a
     * trade is actually placed with something you had to go and find. A stop
     * you have to change tab to read is one you set late.
     */
    render(<MarketState data={base} tf="15m" />);
    expect(screen.getByText('87,200')).toBeInTheDocument();
    expect(screen.getAllByText('Stop loss').length).toBe(2);
    fireEvent.click(screen.getByRole('tab', { name: 'Patterns' }));
    expect(screen.getByText('87,200')).toBeInTheDocument();
    expect(screen.getByText('86,400')).toBeInTheDocument();
  });

  it('a pattern from earlier bars says how far back it was', () => {
    render(<MarketState data={base} tf="15m" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Patterns' }));
    expect(screen.getByText('2 bars ago')).toBeInTheDocument();
  });

  it('[critical] the history tallies what came good, as a count and not a percentage', () => {
    // Four calls is not a hit rate, and a percentage would say it was.
    const rows: StateHistoryRow[] = [
      { id: 1, at: base.at, tf: '15m', event: 'BREAKOUT_CONFIRMED', stage: 'CONFIRMED', side: 'UP', confirmed: true, confidence: 76, close: 86_900, plan: null, outcome: 'CORRECT', gradedAt: base.at },
      { id: 2, at: base.at - 3_600_000, tf: '15m', event: 'RANGE', stage: 'RANGE', side: null, confirmed: false, confidence: 62, close: 86_500, plan: null, outcome: 'NOT_GRADED', gradedAt: null },
      { id: 3, at: base.at - 7_200_000, tf: '15m', event: 'REJECTION', stage: 'FAILED', side: 'DOWN', confirmed: true, confidence: 70, close: 86_610, plan: null, outcome: 'WRONG', gradedAt: base.at },
    ];
    const { container } = render(<MarketState data={base} history={rows} hitRate={{ correct: 1, graded: 2 }} tf="15m" />);
    expect(screen.getByText('1 of 2 came good')).toBeInTheDocument();
    expect(screen.getByText('Correct')).toBeInTheDocument();
    expect(screen.getByText('Wrong')).toBeInTheDocument();
    // A range is not a prediction, so it is not marked right or wrong.
    const outcomes = [...container.querySelectorAll('.bt-market-state__hist-out')].map((e) => e.textContent);
    expect(outcomes).toEqual(['Correct', '—', 'Wrong']);
  });

  it('[critical] each earlier call says what BTC did after it', () => {
    /*
     * The question the row is read to answer. Between two calls it is the move
     * to the next one; for the newest it is the move to the price now -- and
     * the colour follows the call, so a fall after a breakdown is green.
     */
    const rows: StateHistoryRow[] = [
      { id: 3, at: base.at, tf: '15m', event: 'BREAKDOWN_CONFIRMED', stage: 'CONFIRMED', side: 'DOWN', confirmed: true, confidence: 70, close: 86_500, plan: null, outcome: 'CORRECT', gradedAt: base.at },
      { id: 2, at: base.at - 3_600_000, tf: '15m', event: 'BREAKOUT_WATCH', stage: 'WATCH', side: 'UP', confirmed: false, confidence: 60, close: 86_300, plan: null, outcome: 'WRONG', gradedAt: base.at },
    ];
    render(<MarketState data={base} history={rows} tf="15m" spot={86_200} />);
    // newest: 86,200 now against 86,500 called -- 300 down, and it was a breakdown
    const newest = screen.getByText('−300 pts');
    expect(newest.className).toContain('is-up');
    // the one before it: 86,500 at the next call against 86,300 -- up, after a breakout watch
    expect(screen.getByText('+200 pts').className).toContain('is-up');
  });

  it('[critical] shows five calls a page, newest first, and pages back through the rest', () => {
    // Ten rows of small print is a wall nobody reads to the end of.
    const rows: StateHistoryRow[] = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1, at: base.at - i * 900_000, tf: '15m', event: 'RANGE', stage: 'RANGE',
      side: null, confirmed: false, confidence: 50 + i, close: 86_000 + i, plan: null,
      outcome: 'NOT_GRADED' as const, gradedAt: null,
    }));
    render(<MarketState data={base} history={rows} tf="15m" />);
    expect(screen.getByText('1–5 of 12')).toBeInTheDocument();
    expect(document.querySelectorAll('.bt-market-state__history li')).toHaveLength(5);
    expect(screen.getByText('(50)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Newer calls' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Older calls' }));
    expect(screen.getByText('6–10 of 12')).toBeInTheDocument();
    expect(screen.getByText('(55)')).toBeInTheDocument();
    expect(screen.queryByText('(50)')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Older calls' }));
    expect(screen.getByText('11–12 of 12')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Older calls' })).toBeDisabled();
  });

  it('[critical] shows the chart\'s timeframe and does not offer a second switch', () => {
    // Two timeframe controls for one question is two answers on screen the
    // moment they disagree. The chart owns the row; this follows it.
    render(<MarketState data={base} tf="15m" />);
    expect(screen.getByText('15m')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '1h' })).toBeNull();
  });

  it('says so rather than breaking when there is no state yet', () => {
    render(<MarketState data={null} tf="15m" />);
    expect(screen.getByText('No state yet.')).toBeInTheDocument();
  });
});
