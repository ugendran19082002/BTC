import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  },
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

  it('the tabs swap what is under the banner, and the plans stay put', async () => {
    render(<MarketState data={base} tf="15m" />);
    expect(screen.getByText('Volume over 1.5x')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Patterns' }));
    expect(screen.getByText('Ascending Triangle')).toBeInTheDocument();
    expect(screen.queryByText('Volume over 1.5x')).toBeNull();
    expect(screen.getByText('> 86,800')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Indicators' }));
    expect(screen.getByText('RSI (14)')).toBeInTheDocument();
    expect(screen.getByText('1.8x')).toBeInTheDocument();
  });

  it('the full targets show on the Levels tab and are folded away elsewhere', async () => {
    const { container } = render(<MarketState data={base} tf="15m" />);
    expect(container.querySelector('.bt-market-state__plans')!.className).toContain('is-compact');
    await userEvent.click(screen.getByRole('tab', { name: 'Levels' }));
    expect(container.querySelector('.bt-market-state__plans')!.className).not.toContain('is-compact');
    expect(screen.getByText('87,200')).toBeInTheDocument();
  });

  it('a pattern from earlier bars says how far back it was', async () => {
    render(<MarketState data={base} tf="15m" />);
    await userEvent.click(screen.getByRole('tab', { name: 'Patterns' }));
    expect(screen.getByText('2 bars ago')).toBeInTheDocument();
  });

  it('[critical] the history tallies what came good, as a count and not a percentage', () => {
    // Four calls is not a hit rate, and a percentage would say it was.
    const rows: StateHistoryRow[] = [
      { id: 1, at: base.at, tf: '15m', event: 'BREAKOUT_CONFIRMED', stage: 'CONFIRMED', side: 'UP', confirmed: true, confidence: 76, close: 86_900, plan: null, outcome: 'CORRECT', gradedAt: base.at },
      { id: 2, at: base.at - 3_600_000, tf: '15m', event: 'RANGE', stage: 'RANGE', side: null, confirmed: false, confidence: 62, close: 86_500, plan: null, outcome: 'NOT_GRADED', gradedAt: null },
      { id: 3, at: base.at - 7_200_000, tf: '15m', event: 'REJECTION', stage: 'FAILED', side: 'DOWN', confirmed: true, confidence: 70, close: 86_610, plan: null, outcome: 'WRONG', gradedAt: base.at },
    ];
    render(<MarketState data={base} history={rows} hitRate={{ correct: 1, graded: 2 }} tf="15m" />);
    expect(screen.getByText('1 of 2 came good')).toBeInTheDocument();
    expect(screen.getByText('Correct')).toBeInTheDocument();
    expect(screen.getByText('Wrong')).toBeInTheDocument();
    // A range is not a prediction, so it is not marked right or wrong.
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('switches timeframe through the caller', async () => {
    const seen: string[] = [];
    render(<MarketState data={base} tf="15m" tfs={['5m', '15m', '1h']} onTf={(t) => seen.push(t)} />);
    await userEvent.click(screen.getByRole('button', { name: '1h' }));
    expect(seen).toEqual(['1h']);
    expect(screen.getByRole('button', { name: '15m' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('says so rather than breaking when there is no state yet', () => {
    render(<MarketState data={null} tf="15m" />);
    expect(screen.getByText('No state yet.')).toBeInTheDocument();
  });
});
